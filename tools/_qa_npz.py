"""检查 refpose --save-points 写出的窗口 npz 里有哪些数组（用于按像素索引做窗口间尺度对齐）。

用法: python tools/_qa_npz.py <win000.npz> [win001.npz]
"""
import sys

import numpy as np


def main():
    for f in sys.argv[1:]:
        z = np.load(f)
        print("==", f)
        for k in z.files:
            a = z[k]
            print("   %-10s shape=%-16s dtype=%-10s %s" % (
                k, str(a.shape), a.dtype,
                ("" if a.size == 0 else "first=%s" % np.array2string(np.ravel(a)[:6], precision=4))))
        if "uv" in z.files:
            uv = z["uv"]
            print("   uv 形状:", uv.shape, "前 3 行:", uv[:3].tolist() if uv.ndim == 2 else uv[:3])


if __name__ == "__main__":
    main()
