"""快速统计融合点云的几何分布（高度/半径分位），用于判断"径向薄片"是不是天空/远场。

用法: python tools/_qa_cloud.py <fused.ply> <pose.json>
"""
import json
import sys

import numpy as np

sys.path.insert(0, r"C:\D\DLnotebook\tools")
import refscene  # noqa: E402


def main():
    ply, pjf = sys.argv[1], sys.argv[2]
    P, C = refscene.read_ply(ply)
    print("point cloud", P.shape)
    pj = json.load(open(pjf, encoding="utf-8"))
    dv = np.array(pj["down_vector"], float)
    dv /= np.linalg.norm(dv)
    T = np.array([p["c2w"] for p in pj["poses"] if p.get("key")], float).reshape(-1, 4, 4)[:, :3, 3]
    c0 = T[len(T) // 2]
    rel = P - c0
    h = rel @ dv
    r = np.linalg.norm(rel - np.outer(h, dv), axis=1)
    print("height along down:", " ".join("%s%%=%.3f" % (q, np.percentile(h, q)) for q in (1, 5, 25, 50, 75, 95, 99)))
    print("horiz radius    :", " ".join("%s%%=%.3f" % (q, np.percentile(r, q)) for q in (50, 75, 90, 95, 99)))
    print("above ground >1 unit: %.2f%%" % (100 * (h < -1.0).mean()))
    print("below ground >0.5   : %.2f%%" % (100 * (h > 0.5).mean()))
    for lim in (1.5, 2.5, 4.0):
        print("  radius > %.1f: %.2f%%" % (lim, 100 * (r > lim).mean()))


if __name__ == "__main__":
    main()
