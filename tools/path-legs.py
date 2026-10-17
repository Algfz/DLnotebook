#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""path-legs.py —— 按帧切出"单帧曼哈顿腿序列"，并统计关卡的栅格尺度。

输入：path-map.py 产出的 <tag>-map-pts.npz（含 P=世界坐标点、F=帧号）。
对每个帧：
  栅格化该帧的点 → 骨架 → 排序 → Douglas-Peucker → 估计栅格角 g
  → manhattan_rebuild 吸附成曼哈顿折线（axis/off/lo/hi/span）
  → 在栅格坐标系里算"前进轴"（首末点位移主导轴），另一轴即"横轴"
  → 横轴腿的偏移 = 车道位置，相邻车道间距 = 关卡地砖尺度 t 的观测
输出：
  <out>/<tag>-legs.json      每帧 {f, grid_deg, fwd, legs[], lanes[], gaps[], net, n_corner}
  <out>/<tag>-stats.png      腿长直方图 + 车道间距直方图
  <out>/<tag>-frame-<f>.png  若干帧的单帧正射俯视（叠黑折线）
"""
import argparse, importlib.util, json, math, os, sys

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))


def load_mv():
    spec = importlib.util.spec_from_file_location("mvmod", os.path.join(HERE, "map-vector.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mvmod"] = mod
    spec.loader.exec_module(mod)
    return mod


def order_points(P, k=6):
    """把一帧的（已是一维曲线的）点云排成折线：k-NN 图 → 最大连通域 → 两次 BFS 取直径路径。"""
    from scipy.spatial import cKDTree
    from collections import deque
    n = len(P)
    if n < 4:
        raise ValueError("点太少：%d" % n)
    tr = cKDTree(P)
    kk = min(k + 1, n)
    d, j = tr.query(P, k=kk)
    adj = [[] for _ in range(n)]
    for i in range(n):
        for t in range(1, kk):
            dd, jj = d[i, t], j[i, t]
            if dd > 0.25:                       # 长边丢弃（避免跨支桥接）
                continue
            adj[i].append((jj, dd))
            adj[jj].append((i, dd))

    def comp(s):
        seen = np.zeros(n, bool)
        seen[s] = True
        qq = deque([s])
        while qq:
            u = qq.popleft()
            for v, _ in adj[u]:
                if not seen[v]:
                    seen[v] = True
                    qq.append(v)
        return seen

    seen = comp(0)
    best, bi = int(seen.sum()), 0
    for s in range(n):                          # 最大连通域（简单起见只扫前 200 个种子）
        if s % max(1, n // 200):
            continue
        if seen[s]:
            continue
        c = comp(s)
        if c.sum() > best:
            best, bi, seen = int(c.sum()), s, c
    keep = np.nonzero(seen)[0]
    if len(keep) < 4:
        raise ValueError("连通域太小：%d" % len(keep))
    sub = P[keep]
    m = len(keep)
    sub_tr = cKDTree(sub)
    kk2 = min(k + 1, m)
    d2, j2 = sub_tr.query(sub, k=kk2)
    adj2 = [[] for _ in range(m)]
    for i in range(m):
        for t in range(1, kk2):
            if d2[i, t] > 0.25:
                continue
            adj2[i].append((j2[i, t], d2[i, t]))
            adj2[j2[i, t]].append((i, d2[i, t]))

    def bfs(s):
        dist = np.full(m, -1.0)
        prev = np.full(m, -1, int)
        dist[s] = 0.0
        qq = deque([s])
        while qq:
            u = qq.popleft()
            for v, w in adj2[u]:
                if dist[v] < 0:
                    dist[v] = dist[u] + w
                    prev[v] = u
                    qq.append(v)
        t = int(np.argmax(dist))
        return t, dist, prev

    a, _, _ = bfs(0)
    b, dist2, prev2 = bfs(a)
    path, cur = [], b
    while cur >= 0:
        path.append(cur)
        cur = prev2[cur]
    path.reverse()
    return sub[np.asarray(path, int)]           # (n, 2) 有序折线


def q(a, p):
    return float(np.percentile(np.asarray(a, float), p)) if len(a) else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--json", default=None, help="path-map.py 的 <tag>-map.json（可选，取 fps/step）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="map")
    ap.add_argument("--res", type=float, default=400.0, help="每帧栅格分辨率 px/单位")
    ap.add_argument("--tol", type=float, default=0.015, help="Douglas-Peucker 容差（单位）")
    ap.add_argument("--min-span", type=float, default=0.05, help="保留腿的最短跨度")
    ap.add_argument("--sheet", type=int, default=10, help="输出多少张单帧正射图")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    mv = load_mv()

    z = np.load(a.npz, allow_pickle=True)
    P = np.asarray(z["P"], np.float64)
    F = np.asarray(z["F"], np.int32)
    origin = np.asarray(z["origin"], np.float64)
    fps, step = 10.0, 1
    if a.json and os.path.exists(a.json):
        js = json.load(open(a.json, encoding="utf-8"))
        fps = float(js.get("fps", 10.0))
        step = int(js.get("step", 1))
    print("[legs] 点 %d，帧 %d 个，帧范围 %d..%d" % (len(P), len(np.unique(F)), F.min(), F.max()))

    frames = sorted(int(v) for v in np.unique(F))
    recs, all_spans, all_gaps, skipped = [], [], [], []
    picked, want = [], set()
    if a.sheet > 0:
        n = len(frames)
        want = set(frames[int(round(i * (n - 1) / max(1, a.sheet - 1)))] for i in range(a.sheet))

    for f in frames:
        Pk = P[F == f]
        if len(Pk) < 40:
            continue
        try:
            Q = order_points(Pk, k=6)
        except Exception as e:
            skipped.append((f, repr(e)))
            continue
        idx = mv.dp_simplify(Q, a.tol)
        if len(idx) < 3:
            skipped.append((f, "DP 段太少"))
            continue
        g = mv.grid_angle(Q, idx)
        W, segs = mv.manhattan_rebuild(Q, idx, g, a.min_span)
        c, s = math.cos(-g), math.sin(-g)
        Rg = np.array([[c, -s], [s, c]])
        Qg = (Rg @ Q.T).T
        d = Qg[-1] - Qg[0]
        fwd = 0 if abs(d[0]) >= abs(d[1]) else 1
        lanes = sorted({round(float(sg["off"]), 3) for sg in segs if sg["axis"] != fwd})
        gaps = [round(b - x, 3) for x, b in zip(lanes, lanes[1:])]
        legs = [{"axis": int(sg["axis"]), "off": round(float(sg["off"]), 3),
                 "lo": round(float(sg["lo"]), 3), "hi": round(float(sg["hi"]), 3),
                 "span": round(float(sg["span"]), 3)} for sg in segs]
        all_spans += [lg["span"] for lg in legs]
        all_gaps += gaps
        recs.append({"f": f, "grid_deg": round(math.degrees(g), 2), "fwd": int(fwd),
                     "net": round(float(np.hypot(*d)), 3), "n_leg": len(legs),
                     "lanes": lanes, "gaps": gaps, "legs": legs,
                     "n_corner": max(0, len(W) - 2)})
        if f in want:
            picked.append((f, Q, W, g))

    if not recs:
        print("[legs] 没有可用帧")
        return
    with open(os.path.join(a.out, "%s-legs.json" % a.tag), "w", encoding="utf-8") as fh:
        json.dump({"tag": a.tag, "res": a.res, "tol": a.tol, "min_span": a.min_span,
                   "fps": fps, "step": step, "frames": recs}, fh, ensure_ascii=False, indent=1)

    spans = [s for s in all_spans if s >= a.min_span]
    print("[legs] 帧 %d，腿 %d 条（≥%.2f 的 %d 条）  跳过 %d 帧"
          % (len(recs), len(all_spans), a.min_span, len(spans), len(skipped)))
    if skipped[:6]:
        print("[legs] 跳过示例 %s" % (skipped[:6],))
    if spans:
        print("[legs] 腿长: 中位 %.3f  p10 %.3f  p90 %.3f  max %.3f"
              % (q(spans, 50), q(spans, 10), q(spans, 90), max(spans)))
    if all_gaps:
        pos = [x for x in all_gaps if x > 0.01]
        print("[legs] 车道间距: 中位 %.3f  p10 %.3f  p90 %.3f  最小 %.3f（≈地砖尺度 t）"
              % (q(pos, 50), q(pos, 10), q(pos, 90), min(pos)))
    print("[legs] 写出 %s" % os.path.join(a.out, "%s-legs.json" % a.tag))

    # ---- 统计图 ----
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 2, figsize=(11, 4), dpi=110)
        if spans:
            ax[0].hist(spans, bins=40, color="#e2761b")
        ax[0].set_title("leg span (h units)  n=%d" % len(spans))
        ax[0].set_xlabel("length (camera-height units)")
        pos = [x for x in all_gaps if x > 0.01]
        if pos:
            ax[1].hist(pos, bins=40, color="#2b6cb0")
        ax[1].set_title("lane gap (h units)  n=%d" % len(pos))
        ax[1].set_xlabel("gap (camera-height units)")
        fig.tight_layout()
        fig.savefig(os.path.join(a.out, "%s-stats.png" % a.tag))
        print("[legs] 写出 %s" % os.path.join(a.out, "%s-stats.png" % a.tag))
    except Exception as e:                                    # pragma: no cover
        print("[legs] 统计图失败: %r" % (e,))

    # ---- 单帧正射图 ----
    for f, Q, W, g in picked:
        lo = Q.min(0) - 0.05
        hi = Q.max(0) + 0.05
        res = a.res
        cw = max(2, int((hi[0] - lo[0]) * res))
        ch = max(2, int((hi[1] - lo[1]) * res))
        img = np.full((ch, cw, 3), 255, np.uint8)
        pp = ((Q - lo) * res).astype(int)
        img[pp[:, 1], pp[:, 0]] = (40, 90, 230)
        ww = ((W - lo) * res).astype(int)
        cv2.polylines(img, [ww.reshape(-1, 1, 2)], False, (30, 30, 30), 2)
        for v in ww:
            cv2.circle(img, tuple(v), 3, (150, 60, 20), -1)
        img = cv2.resize(img, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_NEAREST)
        cv2.putText(img, "f%05d  grid %.1f deg" % (f, math.degrees(g)), (6, 16),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
        out = os.path.join(a.out, "%s-frame-%05d.png" % (a.tag, f))
        cv2.imwrite(out, img)
        print("[legs] 写出 %s" % out)


if __name__ == "__main__":
    main()
