# -*- coding: utf-8 -*-
"""path-arc.py —— 用"沿路径弧长"的正则化消掉帧间沿轨相位漂移。

背景：路径在画面里近似一维（直段上沿轨不可观测），逐帧 ICP 的位移沿轨分量几乎自由，
误差累积后地图上的锯齿会出现"错相"重影。跳舞的线里相机沿路径**匀速**前进，
所以第 k 帧的弧长应近似 s0 + v·k。本工具：

  1. 读 <tag>-map-pts.npz（P, C, F）+ <tag>-map.json（每帧位姿）；
  2. 从点云骨架抽出路径折线 Γ，并做等弧长参数化 s↦Γ(s)；
  3. 每帧取相机位置在 Γ 上的投影弧长 s_k；按 --mode 正则化：
       mono   单调（PAVA）+ 滑动平均（默认）
       linear 严格匀速（线性插值两端）
       none   不做
  4. 每个点按自己的帧位移 Δ_k = Γ(s_k') − Γ(s_k)，输出新 npz + 地图 PNG。

用法：
  python tools/path-arc.py --npz ...\\s1r-map-pts.npz --json ...\\s1r-map.json \\
      --tag s1a --out ...\\arc --mode mono --res 300
"""
import argparse
import json
import math
import os

import cv2
import numpy as np

try:
    from skimage.morphology import skeletonize
except Exception:
    skeletonize = None


def order_skeleton(mask):
    sk = skeletonize(mask > 0).astype(np.uint8)
    ys, xs = np.nonzero(sk)
    pts = set(zip(xs.tolist(), ys.tolist()))
    if len(pts) < 8:
        raise SystemExit("骨架点太少 %d" % len(pts))
    ends = []
    for (x, y) in pts:
        n = sum((x + dx, y + dy) in pts for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0))
        if n <= 1:
            ends.append((x, y))
    if not ends:
        ends = [next(iter(pts))]

    def bfs(src):
        dist, prev, q = {src: 0}, {}, [src]
        far = src
        for u in q:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if (dx, dy) == (0, 0):
                        continue
                    v = (u[0] + dx, u[1] + dy)
                    if v in pts and v not in dist:
                        dist[v] = dist[u] + 1
                        prev[v] = u
                        if dist[v] > dist[far]:
                            far = v
                        q.append(v)
        return far, prev

    b, _ = bfs(ends[0])
    c, prev = bfs(b)
    path = [c]
    while path[-1] != b:
        path.append(prev[path[-1]])
    path.reverse()
    return np.asarray(path, np.float64)


def pava(y, w=None):
    """保序回归（非降），blocks = [(value, weight)]。"""
    y = np.asarray(y, np.float64)
    w = np.ones_like(y) if w is None else np.asarray(w, np.float64)
    val, wt = [], []
    for yi, wi in zip(y, w):
        v, ww = yi, wi
        while val and val[-1] > v:
            v0, w0 = val.pop(), wt.pop()
            v = (v0 * w0 + v * ww) / (w0 + ww)
            ww = w0 + ww
        val.append(v)
        wt.append(ww)
    out, i = [], 0
    for v, ww in zip(val, wt):
        n = int(round(ww))
        out.extend([v] * n)
        i += n
    return np.asarray(out[:len(y)], np.float64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--map-png", default=None)
    ap.add_argument("--tag", default="arc")
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", type=float, default=300.0)
    ap.add_argument("--tol", type=float, default=0.03)
    ap.add_argument("--mode", default="mono", choices=["mono", "linear", "none", "smooth"])
    ap.add_argument("--win", type=int, default=7, help="mono/smooth 的滑动平均窗")
    ap.add_argument("--map-px", type=float, default=400.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    z = np.load(a.npz)
    P = np.asarray(z["P"], np.float64)
    C = np.asarray(z["C"], np.uint8)
    F = np.asarray(z["F"], np.int32) if "F" in z else None
    js = json.load(open(a.json, encoding="utf-8"))
    poses = js["poses"]
    cam = np.array([[p["T"][0][2], p["T"][1][2]] for p in poses], np.float64)
    fidx = np.array([p["i"] for p in poses], np.int32)
    if F is None:
        raise SystemExit("npz 里没有 F（帧号）——请用新版 path-map.py 重跑")

    # ---- 路径骨架 Γ ----
    lo = P.min(0) - 0.05
    hi = P.max(0) + 0.05
    w = int((hi[0] - lo[0]) * a.res) + 1
    h = int((hi[1] - lo[1]) * a.res) + 1
    m = np.zeros((h, w), np.uint8)
    px = ((P[:, 0] - lo[0]) * a.res).astype(int)
    pz = ((P[:, 1] - lo[1]) * a.res).astype(int)
    ok = (px >= 0) & (px < w) & (pz >= 0) & (pz < h)
    m[pz[ok], px[ok]] = 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    nlab, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if nlab > 1:
        k = 1 + int(np.argmax(stats[1:, 4]))
        m = np.where(lab == k, 255, 0).astype(np.uint8)
    sk = order_skeleton(m)
    G = (sk / a.res) + lo
    # 折线抽稀
    keep = [0]
    for i in range(1, len(G) - 1):
        A, B = G[keep[-1]], G[i]
        if np.hypot(*(B - A)) > 0.02:
            keep.append(i)
    keep.append(len(G) - 1)
    G = G[keep]
    seg = np.hypot(*(np.diff(G, axis=0).T))
    s = np.concatenate([[0.0], np.cumsum(seg)])           # 每点弧长
    L = float(s[-1])
    print("[ar] 路径 Γ：%d 点，总弧长 %.3f h 单位" % (len(G), L))

    # ---- 每帧相机在 Γ 上的弧长 ----
    order = np.argsort(fidx)                              # 按帧号排序（poses 已是顺序）
    s_k = np.zeros(len(cam))
    for k, p in enumerate(cam):
        d = np.hypot(G[:, 0] - p[0], G[:, 1] - p[1])
        s_k[k] = s[int(np.argmin(d))]
    s_raw = s_k.copy()
    if a.mode == "linear":
        s_k = np.linspace(s_k[0], s_k[-1], len(s_k))
    elif a.mode in ("mono", "smooth"):
        s_k = pava(s_k)
        if a.win > 1:
            kk = np.ones(a.win) / a.win
            s_k = np.convolve(s_k, kk, mode="same")
            s_k[0], s_k[-1] = s_raw[0], s_raw[-1]
            s_k = np.maximum.accumulate(s_k)              # 滑动平均后再保证单调
    ds = s_k - s_raw
    print("[ar] 模式 %s：弧长修正 中位 %.4f / p90 %.4f / 最大 %.4f h（占总长 %.1f%%）"
          % (a.mode, np.median(np.abs(ds)), np.percentile(np.abs(ds), 90),
             np.abs(ds).max(), 100 * np.abs(ds).max() / max(L, 1e-9)))

    def gam(x):
        return np.stack([np.interp(x, s, G[:, 0]), np.interp(x, s, G[:, 1])], 1)

    shift = gam(s_k) - gam(s_raw)                         # 每帧的平移修正
    sh = np.zeros_like(P)
    for k, i in enumerate(fidx):
        sh[F == i] = shift[k]
    Pn = P + sh

    # ---- 写出 ----
    lo2, hi2 = Pn.min(0) - 0.05, Pn.max(0) + 0.05
    S = a.map_px
    cw, ch = int((hi2[0] - lo2[0]) * S) + 1, int((hi2[1] - lo2[1]) * S) + 1
    canvas = np.full((ch, cw, 3), 255, np.uint8)
    qx = ((Pn[:, 0] - lo2[0]) * S).astype(int)
    qz = ((Pn[:, 1] - lo2[1]) * S).astype(int)
    good = (qx >= 0) & (qx < cw) & (qz >= 0) & (qz < ch)
    canvas[qz[good], qx[good]] = C[good]
    canvas = cv2.dilate(canvas, np.ones((2, 2), np.uint8))
    occ = int((canvas.reshape(-1, 3).sum(1) < 720).sum())
    px_png = os.path.join(a.out, "%s-map.png" % a.tag)
    cv2.imwrite(px_png, canvas)
    print("[ar] 写出 %s   占格 %d px（同一路径下越小越锐）" % (px_png, occ))
    # 轨迹叠加
    trn = cam + shift
    tp = np.stack([(trn[:, 0] - lo2[0]) * S, (trn[:, 1] - lo2[1]) * S], 1).astype(int)
    vis = canvas.copy()
    cv2.polylines(vis, [tp.reshape(-1, 1, 2)], False, (0, 0, 255), 1)
    cv2.circle(vis, tuple(tp[0]), 5, (0, 180, 0), -1)
    cv2.circle(vis, tuple(tp[-1]), 5, (255, 0, 0), -1)
    cv2.imwrite(os.path.join(a.out, "%s-map-traj.png" % a.tag), vis)
    np.savez_compressed(os.path.join(a.out, "%s-map-pts.npz" % a.tag),
                        P=Pn.astype(np.float32), C=C, F=F,
                        origin=lo2.astype(np.float64), map_px=np.float64(S))
    print("[ar] 写出 %s / %s-map-traj.png / %s-map-pts.npz"
          % (px_png, os.path.join(a.out, a.tag), os.path.join(a.out, a.tag)))


if __name__ == "__main__":
    main()
