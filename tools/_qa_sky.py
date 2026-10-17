"""诊断：新管线点云里"品红/绿色杂点"是什么、在多远处。
用法: python tools/_qa_sky.py <cloud.ply> <render-poses.json> <frame>
"""
import json
import sys
import numpy as np

sys.path.insert(0, r"C:\DLnotebook\tools")
from refscene import read_ply

cloud, poses_path, frame = sys.argv[1], sys.argv[2], int(sys.argv[3])
P, C = read_ply(cloud)
P = np.asarray(P, np.float64); C = np.asarray(C, np.int32)
rp = json.load(open(poses_path, encoding="utf-8"))
fr = rp["frames"][min(frame, len(rp["frames"]) - 1)]
R = np.asarray(fr["R"], np.float64).reshape(3, 3)
t = np.asarray(fr["t"], np.float64).reshape(3)
cam = -R.T @ t                      # w2c 约定下的相机中心
fwd = R.T @ np.array([0.0, 0.0, 1.0])   # 相机 +z 方向在世界的方向
print("相机中心 %s   前向 %s" % (np.round(cam, 3).tolist(), np.round(fwd, 3).tolist()))
print("点云 bbox %s ~ %s" % (np.round(P.min(0), 2).tolist(), np.round(P.max(0), 2).tolist()))
V = P - cam
d = np.linalg.norm(V, axis=1)
cos = (V @ fwd) / np.maximum(d, 1e-9)
front = cos > 0.3
print("在前方(cos>0.3)的点 %d / %d" % (front.sum(), len(P)))

r, g, b = C[:, 0], C[:, 1], C[:, 2]
cls = {
    "黄/沙(R>170,G>140,B<150)": (r > 170) & (g > 140) & (b < 150),
    "品红(R>140,B>140,G<110)": (r > 140) & (b > 140) & (g < 110),
    "绿(G>R+25,G>B+25)": (g > r + 25) & (g > b + 25),
    "白(全>200)": (r > 200) & (g > 200) & (b > 200),
    "红(R>150,G<90,B<90)": (r > 150) & (g < 90) & (b < 90),
}
tot = len(P)
for k, m in cls.items():
    mf = m & front
    print("  %-26s 全部 %6.1f%%  前方 %6.1f%%" % (k, 100 * m.sum() / tot, 100 * mf.sum() / tot))
    if mf.sum() > 100:
        dd = d[mf]
        print("      前方深度 m: p10 %.2f p25 %.2f p50 %.2f p75 %.2f p90 %.2f max %.2f"
              % tuple(np.percentile(dd, [10, 25, 50, 75, 90, 100])))
dd = d[front]
print("所有前方点深度 p50 %.2f p90 %.2f" % (np.median(dd), np.percentile(dd, 90)))
# 按深度分层看颜色构成
print("\n按深度分层（前方点）:")
edges = [0, 0.5, 1, 2, 3, 5, 8, 100]
for i in range(len(edges) - 1):
    m = front & (d >= edges[i]) & (d < edges[i + 1])
    if m.sum() < 50:
        continue
    parts = []
    for k, cm in cls.items():
        parts.append("%s %.0f%%" % (k.split("(")[0], 100 * (cm & m).sum() / m.sum()))
    print("  %.1f~%.1f m: %7d 点  %s" % (edges[i], edges[i + 1], m.sum(), "  ".join(parts)))
