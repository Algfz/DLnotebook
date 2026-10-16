"""ply-sub.py — 把大点云随机抽稀成小 PLY（refrender 走 CDP 传字符串，几百万点会超时）

用法：
  python tools/ply-sub.py <in.ply> <out.ply> [--n 500000]
"""
import argparse
import struct
import sys

import numpy as np


def read_ply(path):
    with open(path, "rb") as f:
        hdr = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError("PLY 头没结束")
            hdr.append(line.decode("ascii", "replace").strip())
            if hdr[-1] == "end_header":
                break
        n = None
        for h in hdr:
            if h.startswith("element vertex"):
                n = int(h.split()[-1])
        if n is None:
            raise ValueError("没有 element vertex")
        raw = f.read(n * 15)
    a = np.frombuffer(raw, dtype=np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                           ("r", "u1"), ("g", "u1"), ("b", "u1")]))
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--n", type=int, default=500000)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    d = read_ply(a.src)
    n = len(d)
    if n > a.n:
        sel = np.random.RandomState(a.seed).choice(n, a.n, replace=False)
        sel.sort()
        d = d[sel]
    hdr = ("ply\nformat binary_little_endian 1.0\nelement vertex %d\n"
           "property float x\nproperty float y\nproperty float z\n"
           "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n" % len(d))
    with open(a.dst, "wb") as f:
        f.write(hdr.encode("ascii"))
        f.write(d.tobytes())
    print("[ply-sub] %d -> %d 点  %s" % (n, len(d), a.dst))


if __name__ == "__main__":
    main()
