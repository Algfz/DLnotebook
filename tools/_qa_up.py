"""_qa_up.py — 判定「世界的上方到底在哪」。
三种独立依据：
  A) 相机自身 y 轴（DA3 约定 x右 y上 z后）逐窗统计 —— 若各窗口 y 轴不一致，说明拼接引入了整体旋转
  B) 轨迹 PCA：行驶游戏里相机中心基本在一个水平面内 ⇒ 最小方差轴 = up 候选
  C) 地面峰值法：沿候选轴做高度直方图，地面是「薄而密」的一层 ⇒ 最尖锐的峰 = up 轴
"""
import json
import sys
import os

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refscene import read_ply  # noqa: E402

POSE = r"C:\DLnotebook-media\tmp\poseda3\desert-s1-pose.json"
PLY = r"C:\DLnotebook-media\tmp\fuse5\desert-s1-fused2.ply"

d = json.load(open(POSE, encoding="utf-8"))
poses = d["poses"]
keys = [(i, np.asarray(p["c2w"], np.float64).reshape(4, 4)) for i, p in enumerate(poses) if p.get("key")]
C = np.array([T[:3, 3] for _, T in keys], np.float64)
Ys = np.array([T[:3, 1] for _, T in keys], np.float64)
Zs = np.array([T[:3, 2] for _, T in keys], np.float64)

print("关键帧 %d 个，索引 %d~%d" % (len(keys), keys[0][0], keys[-1][0]))
print("[A] 相机 y 轴（世界系）全段均值 = %s  长度 %.3f" % (np.round(Ys.mean(0), 3).tolist(), np.linalg.norm(Ys.mean(0))))
print("[A] 相机 z 轴（世界系）全段均值 = %s  长度 %.3f" % (np.round(Zs.mean(0), 3).tolist(), np.linalg.norm(Zs.mean(0))))
print("[A] 逐窗（每 16 关键帧）y 轴均值：")
step = 16
for a in range(0, len(keys), step):
    b = min(a + step, len(keys))
    ym = Ys[a:b].mean(0)
    print("      帧 %3d-%3d  y=%s" % (keys[a][0], keys[b - 1][0], np.round(ym, 2).tolist()))

# B) 轨迹 PCA
Cm = C - C.mean(0)
u, s, vt = np.linalg.svd(Cm, full_matrices=False)
print("[B] 轨迹 PCA 方差 = %s  主轴 = %s" % (np.round(s ** 2 / len(C), 4).tolist(), np.round(vt, 3).tolist()))
print("[B] 最小方差轴（up 候选）= %s" % np.round(vt[2], 3).tolist())

# C) 地面峰值法
P, _ = read_ply(PLY)
P = np.asarray(P, np.float64)
rng = np.random.default_rng(0)
Q = P[rng.choice(len(P), min(200000, len(P)), replace=False)]
cands = {
    "camY": Ys.mean(0) / np.linalg.norm(Ys.mean(0)),
    "trajPCA3": vt[2],
    "ransacN": np.array([-0.279, 0.653, 0.704]),
    "+x": np.array([1.0, 0, 0]), "+y": np.array([0, 1.0, 0]), "+z": np.array([0, 0, 1.0]),
}
print("[C] 高度直方图（240 bin）峰值占比：越高越像地面=up")
for name, ax in cands.items():
    ax = np.asarray(ax, np.float64)
    ax = ax / np.linalg.norm(ax)
    h = Q @ ax
    lo, hi = h.min(), h.max()
    cnt, edges = np.histogram(h, bins=240, range=(lo, hi))
    k = int(np.argmax(cnt))
    frac = cnt[k] / len(Q)
    peak_h = 0.5 * (edges[k] + edges[k + 1])
    # 相机中心在该轴的分布（相机应在地面「上方」）
    hc = C @ ax
    print("      %-9s 峰高占比 %5.2f%%  峰位 %.3f  相机高度 中位 %.3f (%.1f%%~%.1f%%)  总跨度 %.3f"
          % (name, 100 * frac, peak_h, np.median(hc), 100 * (hc < np.percentile(h, 10)) / len(C),
             np.percentile(h, 10), hi - lo))
