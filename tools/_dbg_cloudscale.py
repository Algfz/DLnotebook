"""直接测云尺度估计（射线方向配对版）：打印每帧的方向匹配数与半径比。

用法: python tools/_dbg_cloudscale.py <out_dir> <tag> <wi_a> <wi_b>
"""
import os
import sys

import numpy as np

sys.path.insert(0, r"C:\D\DLnotebook\tools")
import refpose  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402


def main():
    out, tag, wa, wb = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    pa = os.path.join(out, "%s-win%03d.npz" % (tag, wa))
    pb = os.path.join(out, "%s-win%03d.npz" % (tag, wb))
    za, zb = np.load(pa), np.load(pb)
    ia = {int(k): j for j, k in enumerate(za["idxs"])}
    ib = {int(k): j for j, k in enumerate(zb["idxs"])}
    common = sorted(set(ia) & set(ib))
    offa = np.concatenate([[0], np.cumsum(za["pcount"])[:-1]])
    offb = np.concatenate([[0], np.cumsum(zb["pcount"])[:-1]])
    print("公共帧:", common, " fov:", round(float(np.median(za["fov_x"])), 2),
          round(float(np.median(zb["fov_x"])), 2))
    for k in common[:4]:
        A = za["pts"][offa[ia[k]]:offa[ia[k]] + int(za["pcount"][ia[k]])].astype(np.float64)
        B = zb["pts"][offb[ib[k]]:offb[ib[k]] + int(zb["pcount"][ib[k]])].astype(np.float64)
        rs = np.random.RandomState(7 + k)
        Asub = A[rs.choice(len(A), min(4000, len(A)), replace=False)]
        Bsub = B[rs.choice(len(B), min(60000, len(B)), replace=False)]
        ra = np.linalg.norm(Asub, axis=1)
        rb = np.linalg.norm(Bsub, axis=1)
        ua = Asub / ra[:, None]
        ub = Bsub / rb[:, None]
        d_s, nn = cKDTree(ub).query(ua, k=1)
        keep = d_s < 0.05
        ratio = rb[nn][keep] / ra[keep]
        print("  帧 %3d: 方向匹配 %5d/%d  | 角度差 p50 %.4f rad | 半径比 p50 %.4f p10 %.4f p90 %.4f" % (
            k, int(keep.sum()), len(ua), float(np.median(d_s)), float(np.median(ratio)),
            float(np.percentile(ratio, 10)), float(np.percentile(ratio, 90))))
    print("函数返回:", refpose.cloud_scale_between(pa, pb, ia, ib, common))


if __name__ == "__main__":
    main()
