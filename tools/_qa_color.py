"""点云颜色健全性检查：均值/中位/颜色桶 + 最近邻颜色差（判断颜色是否与位置对齐）。"""
import sys
import numpy as np

sys.path.insert(0, r"C:\DLnotebook\tools")
from refscene import read_ply
from scipy.spatial import cKDTree


def report(path):
    try:
        P, C = read_ply(path)
    except Exception as e:
        print("=== %s\n   读取失败: %s" % (path, e)); return
    C = np.asarray(C, np.int32); P = np.asarray(P, np.float64)
    print("=== %s  n=%d" % (path.split("\\")[-1], len(P)))
    print("   xyz 范围 %s ~ %s" % (np.round(P.min(0), 3).tolist(), np.round(P.max(0), 3).tolist()))
    print("   RGB 均值 %s 中位 %s std %s" % (np.round(C.mean(0), 1).tolist(),
          np.median(C, 0).astype(int).tolist(), np.round(C.std(0), 1).tolist()))
    q = (C // 32) * 32
    key = q[:, 0] * 10000 + q[:, 1] * 100 + q[:, 2]
    uq, cnt = np.unique(key, return_counts=True)
    top = np.argsort(-cnt)[:6]
    print("   颜色桶 Top6: %s" % [(int(uq[i] // 10000), int(uq[i] // 100 % 100), int(uq[i] % 100), int(cnt[i])) for i in top])
    rng = np.random.default_rng(0)
    idx = rng.choice(len(P), min(20000, len(P)), replace=False)
    tree = cKDTree(P)
    d, j = tree.query(P[idx], k=2)
    cd = np.abs(C[idx] - C[j[:, 1]]).mean(1)
    ridx = rng.permutation(idx)
    rand = np.abs(C[idx] - C[ridx]).mean(1)
    print("   最近邻中位距离 %.4f | 最近邻颜色差中位 %.1f | 随机配对颜色差中位 %.1f" % (np.median(d[:, 1]), np.median(cd), np.median(rand)))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
