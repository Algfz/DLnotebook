"""ply-rough.py — 用"局部平面厚度"量化点云的粗糙度（不需要位姿，公平比较任意两个点云）

对每个采样点，取半径 r 内的邻居做 PCA，最小特征值对应的方向就是局部法线，
残差 RMS = 点到局部平面的散布。**表面越薄（越像一张面），残差越小**；
被链式位姿抹开、重影、鱼骨纹的点云，局部会变成"厚板"，残差自然变大。

用法：
  python tools\\ply-rough.py --ply A.ply [B.ply ...] --r 0.05 --sample 200000
  python tools\\ply-rough.py --ply A.ply --voxel 0.005      # 先按体素合并再算（更接近"表面"判据）
"""
import argparse
import importlib.util
import os

import numpy as np


def load_refscene():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("refscene", os.path.join(here, "refscene.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", nargs="+", required=True)
    ap.add_argument("--r", type=float, default=0.05, help="邻域半径（点云单位）")
    ap.add_argument("--sample", type=int, default=200000, help="采样点数")
    ap.add_argument("--voxel", type=float, default=0.0, help="先按该体素合并（0=不合并）")
    ap.add_argument("--r-frac", type=float, default=0.0,
                    help="若 >0，则可用半径 = r-frac × 包围盒对角线（不同尺度的点云可比）")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from scipy.spatial import cKDTree
    rs = load_refscene()
    for path in args.ply:
        P, C = rs.read_ply(path)
        n0 = len(P)
        P = np.asarray(P, np.float64)
        if args.voxel > 0:
            k = np.floor(P / args.voxel).astype(np.int64) + (1 << 20)
            key = (k[:, 0] << 42) | (k[:, 1] << 21) | k[:, 2]
            ku, inv = np.unique(key, return_inverse=True)
            acc = np.zeros((len(ku), 3)); cnt = np.zeros(len(ku))
            np.add.at(acc, inv, P); np.add.at(cnt, inv, 1.0)
            P = acc / cnt[:, None]
        if len(P) > args.sample:
            sel = np.random.RandomState(args.seed).choice(len(P), args.sample, replace=False)
            P = P[sel]
        diag = float(np.linalg.norm(P.max(0) - P.min(0)))
        rr = (args.r_frac * diag) if args.r_frac > 0 else args.r
        tree = cKDTree(P)
        nb = tree.query_ball_point(P, rr, workers=-1)
        res = []
        for i, idx in enumerate(nb):
            if len(idx) < 6:
                continue
            Q = P[idx]
            Q = Q - Q.mean(0)
            w = np.linalg.eigvalsh(Q.T @ Q / len(Q))
            res.append(np.sqrt(max(w[0], 0.0)))
        res = np.asarray(res)
        if not len(res):
            print("%-34s 邻域太稀（r=%.3f 找不到 6 个邻居）" % (os.path.basename(path), rr))
            continue
        print("%-30s 点 %9d -> %7d  r %.4f (%.3f×diag)  局部平面厚度 p50 %.4f p90 %.4f p99 %.4f"
              "  |  归一化 p50 %.5f p90 %.5f"
              % (os.path.basename(path), n0, len(P), rr, rr / max(diag, 1e-9),
                 np.percentile(res, 50), np.percentile(res, 90), np.percentile(res, 99),
                 np.percentile(res, 50) / max(diag, 1e-9), np.percentile(res, 90) / max(diag, 1e-9)))


if __name__ == "__main__":
    main()
