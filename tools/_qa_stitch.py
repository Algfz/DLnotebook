"""_qa_stitch.py — 验证「窗间相对旋转」到底对不对。

假设：相邻窗口的重叠关键帧相机中心几乎共线（车沿路直行）⇒ 只用相机中心做 Umeyama
解不出「绕行进轴的滚转」⇒ 相对旋转病态 ⇒ 每窗点云被绕行进轴任意扭转
⇒ 世界不水平 + 薄片/尖刺。

对照三种窗间对齐：
  A 现在用的：只用相机中心 Umeyama（固定尺度）
  B 提议：用重叠帧的相机「朝向矩阵」做 Wahba/旋转平均（尺度沿用 A，平移用中心）
  C 只用中心平移、旋转取单位阵（下界对照）
"""
import glob
import os
import sys

import numpy as np

OUT = r"C:\DLnotebook-media\tmp\poseda3"
TAG = "desert-s1"


def load(wi):
    f = os.path.join(OUT, "%s-win%03d.npz" % (TAG, wi))
    z = np.load(f)
    return {"c2w": z["c2w"], "idxs": z["idxs"], "f": f}


def centers_rot(c2w):
    """从（可能带尺度的）c2w 里取单位正交旋转。"""
    R = c2w[:, :3, :3].astype(np.float64)
    return R, c2w[:, :3, 3].astype(np.float64)


def orthonormalize(R):
    u, s, vt = np.linalg.svd(R)
    return u @ vt


def umeyama_rigid(src, dst):
    """给定对应点，求最优刚体 R,t（不估尺度）。"""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    S = (dst - mu_d).T @ (src - mu_s) / len(src)
    u, _, vt = np.linalg.svd(S)
    d = np.sign(np.linalg.det(u @ vt))
    D = np.diag([1.0, 1.0, d])
    R = u @ D @ vt
    t = mu_d - R @ mu_s
    return R, t


def wahba_rotations(Ra, Rb):
    """求 R 使 R @ Ra[i] ≈ Rb[i]（最小化 Frobenius）。"""
    M = np.zeros((3, 3))
    for A, B in zip(Ra, Rb):
        M += B @ A.T
    u, _, vt = np.linalg.svd(M)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def main():
    a, b = load(0), load(1)
    ca, cb = {}, {}
    for i, ix in enumerate(a["idxs"]):
        ca[int(ix)] = i
    for i, ix in enumerate(b["idxs"]):
        cb[int(ix)] = i
    common = sorted(set(ca) & set(cb))
    print("窗0 帧 %s" % a["idxs"].tolist())
    print("窗1 帧 %s" % b["idxs"].tolist())
    print("重叠 %d 帧: %s" % (len(common), common))

    Ra, Ca = centers_rot(a["c2w"])
    Rb, Cb = centers_rot(b["c2w"])
    ia = np.array([ca[k] for k in common])
    ib = np.array([cb[k] for k in common])
    sa = np.array([np.linalg.norm(Ra[i][:, 0]) for i in ia])
    sb = np.array([np.linalg.norm(Rb[i][:, 0]) for i in ib])
    print("c2w 自带尺度：窗0 %s  窗1 %s" % (np.round(sa, 4).tolist(), np.round(sb, 4).tolist()))

    Ua = np.stack([orthonormalize(Ra[i]) for i in ia])
    Ub = np.stack([orthonormalize(Rb[i]) for i in ib])
    Pa, Pb = Ca[ia], Cb[ib]

    # 共线度：中心点云的 PCA
    for tag, P in (("窗0重叠", Pa), ("窗1重叠", Pb)):
        Q = P - P.mean(0)
        s = np.linalg.svd(Q, compute_uv=False)
        print("  %s 中心坐标奇异值 %s（后两个越小越共线）" % (tag, np.round(s, 5).tolist()))

    # 尺度：中心距离比
    da = np.linalg.norm(np.diff(Pa, axis=0), axis=1).sum()
    db = np.linalg.norm(np.diff(Pb, axis=0), axis=1).sum()
    s_cent = db / max(da, 1e-9)
    # 用「朝向矩阵」看尺度（|R| 的均值比）
    s_rot = sb.mean() / max(sa.mean(), 1e-9)
    print("尺度估计：中心距离比 %.4f  朝向范数比 %.4f" % (s_cent, s_rot))

    print("\n--- A) 只用相机中心 Umeyama（当前做法）---")
    RA, tA = umeyama_rigid(s_cent * Pb[: len(Pb)], Pa)
    resA = np.linalg.norm((RA @ (s_cent * Pb.T)).T + tA - Pa, axis=1)
    print("  中心残差 p50 %.5f max %.5f" % (np.median(resA), resA.max()))
    yerrA = []
    for i in range(len(Ub)):
        yb = RA @ Ub[i][:, 1]
        ya = Ua[i][:, 1]
        yerrA.append(np.degrees(np.arccos(np.clip(abs(float(yb @ ya)), -1, 1))))
    oerrA = []
    for i in range(len(Ub)):
        D = RA @ Ub[i] @ np.linalg.inv(Ua[i])
        oerrA.append(np.degrees(np.arccos(np.clip((np.trace(D) - 1) / 2, -1, 1))))
    print("  映射后 up 轴夹角 p50 %.2f° max %.2f°" % (np.median(yerrA), np.max(yerrA)))
    print("  映射后 朝向差 p50 %.2f° max %.2f°" % (np.median(oerrA), np.max(oerrA)))

    print("\n--- B) 用相机朝向做 Wahba（提议）---")
    RB = wahba_rotations(Ub, Ua)
    tB = Pa.mean(0) - RB @ (s_cent * Pb.mean(0))
    resB = np.linalg.norm((RB @ (s_cent * Pb.T)).T + tB - Pa, axis=1)
    print("  中心残差 p50 %.5f max %.5f" % (np.median(resB), resB.max()))
    yerrB, oerrB = [], []
    for i in range(len(Ub)):
        yb = RB @ Ub[i][:, 1]
        ya = Ua[i][:, 1]
        yerrB.append(np.degrees(np.arccos(np.clip(abs(float(yb @ ya)), -1, 1))))
        D = RB @ Ub[i] @ np.linalg.inv(Ua[i])
        oerrB.append(np.degrees(np.arccos(np.clip((np.trace(D) - 1) / 2, -1, 1))))
    print("  映射后 up 轴夹角 p50 %.2f° max %.2f°" % (np.median(yerrB), np.max(yerrB)))
    print("  映射后 朝向差 p50 %.2f° max %.2f°" % (np.median(oerrB), np.max(oerrB)))

    angAB = np.degrees(np.arccos(np.clip((np.trace(RA.T @ RB) - 1) / 2, -1, 1)))
    print("\nA 与 B 求出的窗间旋转相差 %.2f°" % angAB)

    print("\n--- 全段：逐窗 A/B 的 up 轴一致性 ---")
    files = sorted(glob.glob(os.path.join(OUT, "%s-win*.npz" % TAG)))
    prev = None
    print("  窗对   A:up夹角  A:朝向差 | B:up夹角  B:朝向差 | 尺度")
    for f in files[:12]:
        w = np.load(f)
        R, C = centers_rot(w["c2w"])
        U = np.stack([orthonormalize(R[i]) for i in range(len(R))])
        cur = {"U": U, "C": C, "idx": [int(x) for x in w["idxs"]], "name": os.path.basename(f)}
        if prev is not None:
            cm = sorted(set(prev["idx"]) & set(cur["idx"]))
            if cm:
                pia = [prev["idx"].index(k) for k in cm]
                pib = [cur["idx"].index(k) for k in cm]
                Pa2 = prev["C"][pia]
                Pb2 = cur["C"][pib]
                d1 = np.linalg.norm(np.diff(Pa2, axis=0), axis=1).sum()
                d2 = np.linalg.norm(np.diff(Pb2, axis=0), axis=1).sum()
                sc = d2 / max(d1, 1e-9)
                Ua2 = np.stack([prev["U"][i] for i in pia])
                Ub2 = np.stack([cur["U"][i] for i in pib])
                RA2, _ = umeyama_rigid(sc * Pb2, Pa2)
                RB2 = wahba_rotations(Ub2, Ua2)
                ya2, yb2, oa2, ob2 = [], [], [], []
                for i in range(len(cm)):
                    ya2.append(np.degrees(np.arccos(np.clip(abs(float((RA2 @ Ub2[i][:, 1]) @ Ua2[i][:, 1])), -1, 1))))
                    yb2.append(np.degrees(np.arccos(np.clip(abs(float((RB2 @ Ub2[i][:, 1]) @ Ua2[i][:, 1])), -1, 1))))
                    Da = RA2 @ Ub2[i] @ np.linalg.inv(Ua2[i])
                    Db = RB2 @ Ub2[i] @ np.linalg.inv(Ua2[i])
                    oa2.append(np.degrees(np.arccos(np.clip((np.trace(Da) - 1) / 2, -1, 1))))
                    ob2.append(np.degrees(np.arccos(np.clip((np.trace(Db) - 1) / 2, -1, 1))))
                print("  %s->%s  %6.2f° %6.2f° | %6.2f° %6.2f° | %.4f"
                      % (prev["name"][-9:-4], cur["name"][-9:-4], np.median(ya2), np.median(oa2),
                         np.median(yb2), np.median(ob2), sc))
        prev = cur


if __name__ == "__main__":
    main()
