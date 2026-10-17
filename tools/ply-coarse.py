"""把点云按体素合并（位置+颜色加权平均）——用来验证"体素尺寸 vs 实际配准误差"对观感的影响。
用法: python tools/ply-coarse.py <src.ply> <dst.ply> --voxel 0.02 [--white] [--max-out 3000000]
"""
import argparse
import sys
import numpy as np

sys.path.insert(0, r"C:\DLnotebook\tools")
from refscene import read_ply, write_ply  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--voxel", type=float, default=0.02)
ap.add_argument("--white", action="store_true")
ap.add_argument("--max-out", type=int, default=3000000)
a = ap.parse_args()

P, C = read_ply(a.src)
P = np.asarray(P, np.float64); C = np.asarray(C, np.float64)
key = np.floor(P / a.voxel).astype(np.int64)
# 三轴打包成单一 int64（每轴 21 bit 足够）
key = (key[:, 0] + (1 << 20)) * (1 << 42) + (key[:, 1] + (1 << 20)) * (1 << 21) + (key[:, 2] + (1 << 20))
order = np.argsort(key, kind="stable")
key, P, C = key[order], P[order], C[order]
uniq, start = np.unique(key, return_index=True)
cnt = np.diff(np.append(start, len(key))).astype(np.float64)
sumP = np.add.reduceat(P, start, axis=0)
sumC = np.add.reduceat(C, start, axis=0)
Po = sumP / cnt[:, None]
Co = sumC / cnt[:, None]
if a.white:
    Co = np.full_like(Co, 255.0)
if len(Po) > a.max_out:
    sel = np.random.default_rng(0).choice(len(Po), a.max_out, replace=False)
    Po, Co = Po[sel], Co[sel]
write_ply(a.dst, Po.astype(np.float32), np.clip(Co, 0, 255).astype(np.uint8))
print("[coarse] %d -> %d 点 (voxel %.3f) -> %s" % (len(P), len(Po), a.voxel, a.dst))
