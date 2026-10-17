"""列出已缓存窗口的 fov_x（DA3 每窗自己预测的内参；真值应约 85.58°）。

用法: python tools/_qa_fov.py <out_dir> <tag> [n_windows]
"""
import glob
import os
import sys

import numpy as np


def main():
    out, tag = sys.argv[1], sys.argv[2]
    fs = sorted(glob.glob(os.path.join(out, "%s-win*.npz" % tag)))
    print("窗口数 %d" % len(fs))
    rows = []
    for f in fs:
        z = np.load(f)
        fx = np.asarray(z["fov_x"], float)
        rows.append((os.path.basename(f), float(np.median(fx)), float(fx.min()), float(fx.max())))
    for r in rows:
        flag = "" if abs(r[1] - 85.58) < 2.0 else ("  <== 偏差 %.1f%%" % (100 * (r[1] - 85.58) / 85.58))
        print("  %-24s 中位 %7.2f  范围 %.2f~%.2f%s" % (r[0], r[1], r[2], r[3], flag))
    med = np.array([r[1] for r in rows])
    bad = int(np.sum(np.abs(med - 85.58) > 2.0))
    print("偏离真值 >2° 的窗口: %d / %d （这些窗的点云形状是错的，必须重算）" % (bad, len(rows)))


if __name__ == "__main__":
    main()
