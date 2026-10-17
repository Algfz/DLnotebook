"""_qa_scale.py — 用「点云直接重合度」判定窗间尺度（唯一可信的判据）。

对相邻两窗的重叠帧：
  · 相对旋转 R 用相机朝向做 Wahba（已验证 0.2~1.9°）
  · 平移 t 由对应相机中心给出
  · 尺度 s 扫描，看两个窗的点云重合得最好时 s 是多少
若真值尺度让重合残差降到很小，就说明 s 是主导误差；否则说明平移/位姿也有问题。
"""
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = r"C:\DLnotebook-media\tmp\poseda3"
TAG = "desert-s1"


def orthonormalize(R):
    u, _, vt = np.linalg.svd(R)
    return u @ vt


def wahba(Ra, Rb):
    M = np.zeros((3, 3))
    for A, B in zip(Ra, Rb):
        M += B @ A.T
    u, _, vt = np.linalg.svd(M)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def load(wi):
    z = np.load(os.path.join(OUT, "%s-win%03d.npz" % (TAG, wi)))
    return z


def world_pts(z, j, stride=3, w=1.0):
    """第 j 个关键帧的点（世界系，c2w 为单位旋转）。"""
    c = np.asarray(z["c2w"][j], np.float64)
    R, t = c[:3, :3], c[:3, 3]
    n = int(z["pcount"][j])
    # pts 是拼接的大数组，需要按 pcount 切
    off = 0
    for k in range(j):
        off += int(z["pcount"][k])
    P = np.asarray(z["pts"][off:off + n], np.float64)
    P = P[::stride]
    return (w * (R @ P.T).T) + t


def main():
    a, b = load(0), load(1)
    ia = [int(x) for x in a["idxs"]]
    ib = [int(x) for x in b["idxs"]]
    common = sorted(set(ia) & set(ib))
    ka = [ia.index(k) for k in common]
    kb = [ib.index(k) for k in common]
    print("重叠帧 %s（各 %d 帧）" % (common, len(common)))
    Ca = np.array([np.asarray(a["c2w"][j], np.float64)[:3, 3] for j in ka])
    Cb = np.array([np.asarray(b["c2w"][j], np.float64)[:3, 3] for j in kb])
    Ua = np.array([orthonormalize(np.asarray(a["c2w"][j], np.float64)[:3, :3]) for j in ka])
    Ub = np.array([orthonormalize(np.asarray(b["c2w"][j], np.float64)[:3, :3]) for j in kb])
    R = wahba(Ub, Ua)

    # 尺度判据①：同一对相机中心的距离比（对每对帧取比，再取中位）
    ratios = []
    for i in range(len(Ca)):
        for k in range(i + 1, len(Ca)):
            da = np.linalg.norm(Ca[i] - Ca[k])
            db = np.linalg.norm(Cb[i] - Cb[k])
            if db > 1e-6:
                ratios.append(da / db)
    print("① 相机中心距离比 中位 %.4f  (p10 %.4f p90 %.4f, n=%d)"
          % (np.median(ratios), np.percentile(ratios, 10), np.percentile(ratios, 90), len(ratios)))

    # 尺度判据②：d_ground（相机离地高）比
    da = np.asarray(a["d_ground"], np.float64)[ka]
    db = np.asarray(b["d_ground"], np.float64)[kb]
    ok = np.isfinite(da) & np.isfinite(db) & (db > 1e-6)
    if ok.sum() >= 3:
        print("② d_ground 比 中位 %.4f  (n=%d)" % (np.median(da[ok] / db[ok]), int(ok.sum())))

    # 尺度判据③：点云重合（扫 s）——用中间重叠帧，只取两窗各 1 帧的密集点
    mid = common[len(common) // 2]
    ja, jb = ia.index(mid), ib.index(mid)
    Pa = world_pts(a, ja, stride=2)
    Pb = world_pts(b, jb, stride=2)
    print("重合测试用帧 %d：窗0 %d 点 / 窗1 %d 点" % (mid, len(Pa), len(Pb)))
    t_from_centers = Ca.mean(0) - 1.0 * (R @ Cb.mean(0))
    tree_a = cKDTree(Pa[np.random.default_rng(0).choice(len(Pa), min(60000, len(Pa)), replace=False)])
    sub = Pb[np.random.default_rng(1).choice(len(Pb), min(20000, len(Pb)), replace=False)]
    print("    s       中位NN距离   p25      p75")
    best = (None, 1e9)
    for s in np.concatenate([np.linspace(0.2, 3.0, 29)]):
        Q = (s * (R @ sub.T)).T + (Ca.mean(0) - s * (R @ Cb.mean(0)))
        d, _ = tree_a.query(Q)
        med = float(np.median(d))
        if med < best[1]:
            best = (s, med)
        if abs(s - 0.5) < 0.06 or abs(s - np.median(ratios)) < 0.06 or abs(s - 1.0) < 0.06 or abs(s - 1.5) < 0.06:
            print("   %5.3f    %8.4f  %7.4f  %7.4f" % (s, med, np.percentile(d, 25), np.percentile(d, 75)))
    print("   最佳 s = %.3f（中位NN %.4f）" % best)
    print("   相机尺度比 %.4f 时的中位NN = %.4f"
          % (np.median(ratios), float(np.median(tree_a.query((np.median(ratios) * (R @ sub.T)).T + (Ca.mean(0) - np.median(ratios) * (R @ Cb.mean(0))))[0]))))

    # 只对「地面点」做重合（去掉天空/远场）
    sel = Pb[:, 1] < np.percentile(Pb[:, 1], 40)
    print("   （窗1 点有 %.0f%% 落在 y 低 40%% 区间内）" % (100 * sel.mean()))


if __name__ == "__main__":
    main()
