"""_qa_win.py — 两件事：
 (1) 单窗内部自洽性：同一窗内两帧的点云按各自 c2w 摆好，重合残差有多大？
     （这是整条链路的精度下限 —— 若这里就很大，说明 DA3 单窗内部几何就不一致）
 (2) 窗间 (s,t) 联合求解：R 用相机朝向 Wahba，然后在点云上交替做 NN 匹配 + 求 s,t
"""
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

OUT = r"C:\DLnotebook-media\tmp\poseda3"
TAG = "desert-s1"


def orth(R):
    u, _, vt = np.linalg.svd(R)
    return u @ vt


def wahba(Ra, Rb):
    M = np.zeros((3, 3))
    for A, B in zip(Ra, Rb):
        M += B @ A.T
    u, _, vt = np.linalg.svd(M)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def frame_pts(z, j):
    n = int(z["pcount"][j])
    off = int(np.sum(z["pcount"][:j]))
    return np.asarray(z["pts"][off:off + n], np.float64)


def cam(z, j):
    c = np.asarray(z["c2w"][j], np.float64)
    return c[:3, :3], c[:3, 3]


def world(z, j):
    R, t = cam(z, j)
    return (R @ frame_pts(z, j).T).T + t


def nn_med(A, B, tree_pool=120000, q_pool=25000, seed=0):
    rng = np.random.default_rng(seed)
    if len(A) > tree_pool:
        A = A[rng.choice(len(A), tree_pool, replace=False)]
    if len(B) > q_pool:
        B = B[rng.choice(len(B), q_pool, replace=False)]
    tr = cKDTree(A)
    d, i = tr.query(B)
    return float(np.median(d)), d, i, A, B


def main():
    a = np.load(os.path.join(OUT, "%s-win000.npz" % TAG))
    b = np.load(os.path.join(OUT, "%s-win001.npz" % TAG))

    print("=== (1) 单窗内部自洽性（窗0，同一窗内不同帧的两个点云应当完全重合）===")
    for (j1, j2) in [(0, 4), (0, 8), (0, 15), (4, 12)]:
        P1, P2 = world(a, j1), world(a, j2)
        med, d, _, _, _ = nn_med(P1, P2)
        print("   窗0 帧%2d ↔ 帧%2d：中位NN %8.5f  p25 %.5f  p75 %.5f  (点数 %d/%d)"
              % (j1, j2, med, np.percentile(d, 25), np.percentile(d, 75), len(P1), len(P2)))
    Pa = world(a, 0)
    print("   参考：点云整体尺度（包围盒对角线）%.3f" % np.linalg.norm(Pa.max(0) - Pa.min(0)))

    print("\n=== (2) 窗间 (s,t) 联合求解（窗0 ↔ 窗1，重叠帧）===")
    ia = [int(x) for x in a["idxs"]]
    ib = [int(x) for x in b["idxs"]]
    common = sorted(set(ia) & set(ib))
    ka = [ia.index(k) for k in common]
    kb = [ib.index(k) for k in common]
    Ua = np.array([orth(np.asarray(a["c2w"][j], np.float64)[:3, :3]) for j in ka])
    Ub = np.array([orth(np.asarray(b["c2w"][j], np.float64)[:3, :3]) for j in kb])
    R = wahba(Ub, Ua)
    Ca = np.array([np.asarray(a["c2w"][j], np.float64)[:3, 3] for j in ka])
    Cb = np.array([np.asarray(b["c2w"][j], np.float64)[:3, 3] for j in kb])

    # 用重叠帧的全部点拼成两个大点云（都在各自窗的世界系里）
    Aall = np.concatenate([world(a, j) for j in ka[:4]])
    Ball = np.concatenate([world(b, j) for j in kb[:4]])
    print("   参与配准：窗0 %d 点 / 窗1 %d 点（各前 4 个重叠帧）" % (len(Aall), len(Ball)))

    s = 1.6
    t = Ca.mean(0) - s * (R @ Cb.mean(0))
    treeA = cKDTree(Aall[np.random.default_rng(0).choice(len(Aall), min(150000, len(Aall)), replace=False)])
    rng = np.random.default_rng(1)
    sub = Ball[rng.choice(len(Ball), min(25000, len(Ball)), replace=False)]

    print("   迭代前：s=%.3f  t=%s" % (s, np.round(t, 3).tolist()))
    for it in range(8):
        Q = (s * (R @ sub.T)).T + t
        d, idx = treeA.query(Q)
        thr = np.percentile(d, 60)
        m = d < max(thr, 0.05)
        Aq = treeA.data[idx[m]]
        Bq = sub[m]
        # 求 s：||A - t|| / ||R B||
        num = np.linalg.norm(Aq - Aq.mean(0), axis=1)
        den = np.linalg.norm((R @ Bq.T).T - (R @ Bq.T).T.mean(0), axis=1)
        s_new = float(np.median(num / np.maximum(den, 1e-9)))
        s = 0.5 * s + 0.5 * s_new
        Q = (s * (R @ sub.T)).T
        t = (Aq - Q[m]).mean(0)
        if it % 2 == 0 or it == 7:
            print("   it%d: 内点 %5d (%.0f%%)  中位NN %.5f  s=%.4f  t=%s"
                  % (it, int(m.sum()), 100 * m.mean(), np.median(d[m]), s, np.round(t, 3).tolist()))

    # 与相机中心给出的 t 比较
    t_cam = Ca.mean(0) - s * (R @ Cb.mean(0))
    print("   用点云解出的 t 与用相机中心给的 t 差 %.4f" % np.linalg.norm(t - t_cam))
    print("   对应相机中心残差（用点云 t）p50 %.4f"
          % np.median(np.linalg.norm((s * (R @ Cb.T)).T + t - Ca, axis=1)))
    print("   对应相机中心残差（用相机 t）p50 %.4f"
          % np.median(np.linalg.norm((s * (R @ Cb.T)).T + t_cam - Ca, axis=1)))


if __name__ == "__main__":
    main()
