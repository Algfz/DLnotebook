"""refpose.py — 用 DA3-Giant 多视图解出**关键帧真位姿**，把一段帧序列钉在统一世界系里

为什么要它：之前帧间只用 2D 相似变换（LK 光流）链式累积，长距离必然漂移，
融合后地面被抹成扇形/重影。DA3-Giant 在**连续小基线多视图**下能给出几何一致的相机位姿
（实测 8 帧连续窗口 fov 互相一致、相机中心真在动），所以拿它当"锚点"。

做法：
  1. 关键帧 = 每 key_step 帧取一帧（默认 2 ⇒ 10fps 序列上相当于 5fps）；
  2. 关键帧按 win 长度、stride 步长切成**重叠窗口**（默认 16/8 ⇒ 50% 重叠），逐窗跑 DA3-Giant；
     每个窗口结果缓存到 <out>/<tag>-win-XXX.npz（可续跑，重跑不用重算）；
  3. 相邻窗口用**重叠关键帧的相机中心**做含尺度的 Sim3 配准（Umeyama + 残差裁剪），
     逐窗累积成全局世界系 G_k（DA3 每窗尺度可能不同，必须带尺度）；
  4. 关键帧位姿 -> 全帧位姿：相邻关键帧之间位置线性插值 + 旋转 slerp（步长 0.1~0.2s，误差可忽略）；
  5. 落盘 <tag>-pose.json（每帧 c2w/w2c + 关键帧标记 + 来源）与 <tag>-render-poses.json
     （refrender.mjs --poses 要的 {frames:[{R,t}]} = w2c 形式）。

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\refpose.py --dir <帧目录> --tag desert-s1 --out <out> --max-windows 1   # 试一个窗
  python tools\\refpose.py --dir <帧目录> --tag desert-s1 --out <out>                  # 全跑
"""
import argparse
import importlib.util
import json
import math
import os
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DA3_DIR = r"C:\DLnotebook-media\models\depth-anything__DA3NESTED-GIANT-LARGE"


def log(*a):
    print(*a, flush=True)


def load_da3():
    path = os.path.join(HERE, "refserve-da3.py")
    spec = importlib.util.spec_from_file_location("refserve_da3", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_refmotion():
    path = os.path.join(HERE, "refmotion.py")
    spec = importlib.util.spec_from_file_location("refmotion", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_bgr(path):
    b = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(b, cv2.IMREAD_COLOR)


# ----------------------------------------------------------------- 几何小工具
def c2w_from_w2c(ext34):
    E = np.eye(4)
    E[:3, :] = np.asarray(ext34, np.float64)[:3, :]
    return np.linalg.inv(E)


def w2c_from_c2w(T):
    return np.linalg.inv(T)


def quat_from_R(R):
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    q = np.array([w, x, y, z], np.float64)
    return q / np.linalg.norm(q)


def R_from_quat(q):
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], np.float64)


def slerp(q0, q1, a):
    if np.dot(q0, q1) < 0:
        q1 = -q1
    d = float(np.clip(np.dot(q0, q1), -1, 1))
    if d > 0.9995:
        return (q0 * (1 - a) + q1 * a) / np.linalg.norm(q0 * (1 - a) + q1 * a)
    th = math.acos(d)
    return (math.sin((1 - a) * th) * q0 + math.sin(a * th) * q1) / math.sin(th)


def cloud_scale_between(npz_a, npz_b, idx_a, idx_b, common, max_src=4000, max_dst=60000):
    """用两个窗**同一批关键帧的点云**直接估窗间尺度（比地面高之比稳得多）。

    关键：同一帧在两窗里都存成**该帧相机系**的点 ⇒ 相机原点相同，两片云只差 DA3 各窗
    自己的深度尺度（实测可达 ±20~30%）与形状误差。DA3 的深度是"沿射线"的，所以
    **按射线方向配对**（把点归一化到单位球）、再用半径之比取中位，就是天然的尺度不变量。
    （早先按 3D 最近邻 + 距离阈值配对，尺度差 30% 时一个匹配都留不下 ⇒ 估不出来。）
    返回 prev/cur 的尺度比（与 ground 分支同一语义：把 cur 缩放到 prev 的尺度）。
    """
    from scipy.spatial import cKDTree
    try:
        za, zb = np.load(npz_a), np.load(npz_b)
    except Exception:                                              # noqa: BLE001
        return None
    if "pts" not in za.files or "pts" not in zb.files:
        return None
    pts_a, cnt_a, pts_b, cnt_b = za["pts"], za["pcount"], zb["pts"], zb["pcount"]
    offa = np.concatenate([[0], np.cumsum(cnt_a)[:-1]])
    offb = np.concatenate([[0], np.cumsum(cnt_b)[:-1]])
    ratios = []
    for k in common:
        if k not in idx_a or k not in idx_b:
            continue
        ja, jb = idx_a[k], idx_b[k]
        A = pts_a[offa[ja]:offa[ja] + int(cnt_a[ja])].astype(np.float64)
        B = pts_b[offb[jb]:offb[jb] + int(cnt_b[jb])].astype(np.float64)
        if len(A) < 500 or len(B) < 500:
            continue
        rs = np.random.RandomState(7 + k)
        Asub = A[rs.choice(len(A), min(max_src, len(A)), replace=False)]
        Bsub = B[rs.choice(len(B), min(max_dst, len(B)), replace=False)]
        ra = np.linalg.norm(Asub, axis=1)
        rb = np.linalg.norm(Bsub, axis=1)
        good_a, good_b = ra > 1e-6, rb > 1e-6
        ua = Asub[good_a] / ra[good_a][:, None]
        ub = Bsub[good_b] / rb[good_b][:, None]
        ra_g, rb_g = ra[good_a], rb[good_b]
        if len(ua) < 500 or len(ub) < 500:
            continue
        d_s, nn = cKDTree(ub).query(ua, k=1)          # 单位球上最近 ⇒ 同一条射线
        keep = d_s < 0.05                             # 方向一致（≈±3°）
        if keep.sum() < 300:
            continue
        ratio = rb_g[nn][keep] / ra_g[keep]
        s_k = float(np.median(ratio))
        if 0.3 < s_k < 3.0:
            ratios.append(s_k)
    if len(ratios) < 3:
        return None
    return 1.0 / float(np.median(ratios))


def umeyama_sim3(src, dst, with_scale=True, trim=2.5):
    """求相似变换 (s,R,t) 使 dst ≈ s·R·src + t，带一次残差裁剪"""
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    for _ in range(3):
        mu_s, mu_d = src.mean(0), dst.mean(0)
        Sc, Dc = src - mu_s, dst - mu_d
        C = Dc.T @ Sc / len(src)
        U, S, Vt = np.linalg.svd(C)
        D = np.eye(3)
        if np.linalg.det(U) * np.linalg.det(Vt) < 0:
            D[2, 2] = -1
        R = U @ D @ Vt
        var_s = (Sc ** 2).sum() / len(src)
        s = float((S * np.diag(D)).sum() / var_s) if with_scale else 1.0
        t = mu_d - s * R @ mu_s
        res = np.linalg.norm((s * (R @ src.T).T + t) - dst, axis=1)
        if len(res) <= 6:
            break
        keep = res <= max(trim * float(np.median(res)), 1e-9)
        if keep.all():
            break
        src, dst = src[keep], dst[keep]
    return s, R, t, res


def orthonormalize(R):
    u, _, vt = np.linalg.svd(np.asarray(R, np.float64))
    return u @ vt


def wahba_rotations(Rb, Ra):
    """求 R 使 R·Rb[i] ≈ Ra[i]（Frobenius 最小）。相机「朝向」是可靠的，
    而相机「中心」在沿路直行时几乎共线 ⇒ 只靠中心的 Umeyama 解不出绕行进轴的滚转。"""
    M = np.zeros((3, 3))
    for A, B in zip(Ra, Rb):
        M += np.asarray(A, np.float64) @ np.asarray(B, np.float64).T
    u, _, vt = np.linalg.svd(M)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def npz_frames(path):
    """打开窗 npz 并给出每帧点的切片偏移。"""
    z = np.load(path)
    if "pts" not in z.files:
        return None, None
    cnt = np.asarray(z["pcount"])
    off = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    return z, off


def frame_world_pts(z, off, j, stride=3, cap=40000, scale=1.0):
    """第 j 帧的点云（该窗世界系），stride 抽稀，cap 上限。"""
    n = int(z["pcount"][j])
    P = z["pts"][int(off[j]):int(off[j]) + n]
    if len(P) == 0:
        return np.zeros((0, 3))
    step = max(stride, int(np.ceil(len(P) / float(cap))))
    P = np.asarray(P[::step], np.float64)
    T = np.asarray(z["c2w"][j], np.float64)
    return scale * (T[:3, :3] @ P.T).T + T[:3, 3]


def refine_window_similarity(za, offa, zb, offb, ia, ib, common, R, s0, t0,
                             frames=4, cap=40000, iters=6, scale_lr=0.5):
    """在重叠帧的**点云**上联合精修 (s,t)（R 固定为朝向解）。
    返回 (s, t, 中位重合残差, 内点比例)；失败返回 None。"""
    if za is None or zb is None:
        return None
    picks = common[:: max(1, len(common) // frames)][:frames]
    A, B = [], []
    for k in picks:
        if k not in ia or k not in ib:
            continue
        PA = frame_world_pts(za, offa, ia[k], cap=cap)
        PB = frame_world_pts(zb, offb, ib[k], cap=cap)
        if len(PA) > 200 and len(PB) > 200:
            A.append(PA)
            B.append(PB)
    if not A:
        return None
    from scipy.spatial import cKDTree
    A = np.concatenate(A)
    B = np.concatenate(B)
    rng = np.random.RandomState(3)
    ref = A[rng.choice(len(A), min(120000, len(A)), replace=False)]
    tree = cKDTree(ref)
    if len(B) > 25000:
        B = B[rng.choice(len(B), 25000, replace=False)]
    s, t = float(s0), np.asarray(t0, np.float64)
    res_med, inl = np.nan, 0.0
    for it in range(iters):
        Q = s * (R @ B.T).T + t
        d, idx = tree.query(Q)
        thr = max(float(np.percentile(d, 60)), 0.02)
        m = d < thr
        if int(m.sum()) < 200:
            break
        Aq, Bq = ref[idx[m]], B[m]
        Ra_ = np.linalg.norm(Aq - Aq.mean(0), axis=1)
        Rb_ = np.linalg.norm((R @ Bq.T).T - (R @ Bq.T).T.mean(0), axis=1)
        ok = Rb_ > 1e-6
        if ok.sum() >= 200:
            s_new = float(np.median(Ra_[ok] / Rb_[ok]))
            s = (1 - scale_lr) * s + scale_lr * s_new
        t = (Aq - s * (R @ Bq.T).T).mean(0)
        res_med, inl = float(np.median(d[m])), float(m.mean())
    return s, t, res_med, inl


def apply_sim3(s, R, t, X):
    X = np.asarray(X, np.float64)
    return s * (R @ X.T).T + t


def sim3_to_se3(s, R, t):
    T = np.eye(4)
    T[:3, :3] = s * R
    T[:3, 3] = t
    return T


# ----------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="帧目录（f%05d.jpg）")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--key-step", type=int, default=2, help="关键帧间隔（2 = 5fps）")
    ap.add_argument("--win", type=int, default=16, help="DA3 每窗帧数")
    ap.add_argument("--stride", type=int, default=8, help="窗步长（<win 即重叠）")
    ap.add_argument("--process-res", type=int, default=504)
    ap.add_argument("--fov-x", type=float, default=0.0,
                    help="强制水平视场角（度）。DA3 每窗预测的内参在这批素材上能从 50° 跳到 111°"
                         "（真值 85.58°），不锁死就会让各窗点云横向尺度不一致，融合出放射状薄片。")
    ap.add_argument("--conf-pct", type=float, default=20.0)
    ap.add_argument("--dtype", default="fp32")
    ap.add_argument("--ckpt", default=DA3_DIR)
    ap.add_argument("--frames", default=None, help="帧范围，如 0-690")
    ap.add_argument("--cache", default=None, help="MoGe 缓存目录（用其 |d| 给每个窗定尺度，统一到 MoGe 尺度）")
    ap.add_argument("--mtag", default=None, help="MoGe 缓存的 tag（缺省 = --tag）")
    ap.add_argument("--norm-moge", action="store_true",
                    help="按 MoGe 相机高把每个窗归一到 MoGe 尺度（默认关：MoGe 相机高本身在不同窗漂 2 倍，不如 DA3 自己的地面高稳）")
    ap.add_argument("--max-windows", type=int, default=0, help="只跑前 N 个窗（试跑用）")
    ap.add_argument("--max-res-x", type=int, default=0, help=">0 时把输入缩到该宽度再送 DA3（省显存）")
    ap.add_argument("--save-points", action="store_true",
                    help="把 DA3 每帧的多视图点云也存进窗口 npz（DA3 多视图深度自洽，是干净融合的关键）")
    ap.add_argument("--px-step", type=int, default=2, help="存点云时的像素抽稀步长")
    ap.add_argument("--skip-dark", action="store_true",
                    help="送 DA3 前剔除黑场/转场帧（关键帧级，按亮度均值/标准差判）")
    ap.add_argument("--dark-mean", type=float, default=14.0)
    ap.add_argument("--dark-std", type=float, default=3.0)
    ap.add_argument("--stitch-mode", choices=["orient", "centers"], default="orient",
                    help="窗间相对旋转解法：orient=用相机朝向做 Wahba（默认，必需）；centers=旧的只用相机中心 Umeyama（沿路直行时共线病态，勿用）")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith((".jpg", ".png")))
    if args.frames:
        a, b = args.frames.split("-")
        files = files[int(a):int(b)]
    n = len(files)
    keys = list(range(0, n, args.key_step))
    if keys[-1] != n - 1:
        keys.append(n - 1)
    if args.skip_dark:
        import numpy as _np
        from PIL import Image as _Im
        keep, drop = [], 0
        for i in keys:
            try:
                g = _np.asarray(_Im.open(os.path.join(args.dir, files[i])).convert("L"), dtype=_np.float32)
            except Exception:
                keep.append(i)
                continue
            if g.mean() < args.dark_mean or g.std() < args.dark_std:
                drop += 1
                continue
            keep.append(i)
        if len(keep) >= max(4, args.win):
            if drop:
                log("[pose] 黑场/转场帧剔除 %d/%d（mean<%.0f 或 std<%.0f）" % (drop, len(keys), args.dark_mean, args.dark_std))
            keys = keep
        else:
            log("[pose] 黑场帧占比过高（剩 %d），不剔除" % len(keep))
    kn = len(keys)
    log("[pose] %s: %d 帧, 关键帧 %d (key_step=%d), 窗 %d/步 %d" % (args.tag, n, kn, args.key_step, args.win, args.stride))

    wins = []
    s = 0
    while s < kn:
        e = min(kn, s + args.win)
        wins.append((s, e))
        if e >= kn:
            break
        s += args.stride
    if args.max_windows:
        wins = wins[:args.max_windows]
    log("[pose] 窗口 %d 个" % len(wins))

    da3 = load_da3()
    rm = load_refmotion()
    model = device = None
    results = []
    t_all = time.time()
    for wi, (a, b) in enumerate(wins):
        cf = os.path.join(args.out, "%s-win%03d.npz" % (args.tag, wi))
        idxs = keys[a:b]
        stale_fov = False
        if os.path.exists(cf):
            z = np.load(cf)
            c2w = z["c2w"]
            # ★ 缓存里记着**这一窗到底装了哪些帧**：必须以它为准。窗口布局（keys[a:b]）在不同
            # 版本/不同关键帧序列下会变（例如末尾是否补最后一帧），若拿新的 idxs 去配旧的 c2w，
            # 帧号与位姿就错位了（实测 s2/s3 触发 IndexError，s1 恰好一致才没暴露）。
            if "idxs" in z.files:
                cidxs = [int(x) for x in z["idxs"]]
                if len(cidxs) == len(c2w):
                    if cidxs != list(idxs):
                        log("  [win %3d] 缓存帧号与当前布局不同（%d vs %d 帧）⇒ 按缓存里的帧号走"
                            % (wi, len(cidxs), len(idxs)))
                    idxs = cidxs
                else:
                    log("  [win %3d] 缓存 idxs 与 c2w 长度不一致（%d vs %d）⇒ 重算"
                        % (wi, len(cidxs), len(c2w)))
                    stale_fov = True
            fovx = z["fov_x"]
            dg = z["d_ground"] if "d_ground" in z else np.full(len(c2w), np.nan)
            pts_s = z["pts"] if "pts" in z.files else None
            pcnt = z["pcount"] if "pcount" in z.files else None
            prgb = z["prgb"] if "prgb" in z.files else None
            if args.save_points and pts_s is None:
                log("  [win %3d] 缓存里没有点云，重算" % wi)
            # 强制 fov 时：缓存里那一窗的 fov 偏离给定值 ⇒ 它的点云形状是错的，必须重算
            if args.fov_x and abs(float(np.median(fovx)) - float(args.fov_x)) > 1.0:
                log("  [win %3d] 缓存 fov %.1f° ≠ 强制 %.1f° ⇒ 重算" % (
                    wi, float(np.median(fovx)), float(args.fov_x)))
                pts_s = pcnt = prgb = None
                stale_fov = True
        else:
            pts_s = pcnt = prgb = None
        if not os.path.exists(cf) or stale_fov or (args.save_points and pts_s is None):
            if model is None:
                model, device = da3.load_model(args.ckpt, None, args.dtype)
            imgs = []
            for k in idxs:
                im = load_bgr(os.path.join(args.dir, files[k]))
                if args.max_res_x and im.shape[1] > args.max_res_x:
                    sc = args.max_res_x / im.shape[1]
                    im = cv2.resize(im, (args.max_res_x, int(round(im.shape[0] * sc))), interpolation=cv2.INTER_AREA)
                imgs.append(im)
            t0 = time.time()
            outs = da3.infer(model, imgs, process_res=args.process_res,
                             conf_pct=args.conf_pct, use_autocast=(args.dtype != "fp32"),
                             fov_x=args.fov_x)
            c2w, fovx, dg = [], [], []
            plist, rlist, cnt = [], [], []
            for fr in outs:
                if fr.get("ext_w2c") is None:
                    T = np.eye(4)
                else:
                    T = c2w_from_w2c(fr["ext_w2c"])
                c2w.append(T)
                fovx.append(fr.get("fov_x") or 0.0)
                # 顺便用 DA3 自己的点云拟合地面，给 MoGe->DA3 的尺度一个初值
                try:
                    gf = rm.ground_frame(fr)
                    dg.append(float(gf["d"]) if gf else float("nan"))
                except Exception:
                    dg.append(float("nan"))
                if args.save_points:
                    st = max(1, args.px_step)
                    Pm = fr["points"][::st, ::st].reshape(-1, 3)
                    mk = fr["mask"][::st, ::st].reshape(-1) & np.isfinite(Pm).all(1)
                    if mk.sum():
                        plist.append(Pm[mk].astype(np.float32))
                        rlist.append(fr["_img"][::st, ::st].reshape(-1, 3)[mk][:, ::-1].astype(np.uint8))
                    else:
                        plist.append(np.zeros((0, 3), np.float32))
                        rlist.append(np.zeros((0, 3), np.uint8))
                    cnt.append(int(mk.sum()))
            c2w = np.asarray(c2w, np.float64)
            fovx = np.asarray(fovx, np.float64)
            dg = np.asarray(dg, np.float64)
            if args.save_points:
                pts_s = np.concatenate(plist, 0) if plist else np.zeros((0, 3), np.float32)
                prgb = np.concatenate(rlist, 0) if rlist else np.zeros((0, 3), np.uint8)
                pcnt = np.asarray(cnt, np.int32)
                np.savez_compressed(cf, c2w=c2w, fov_x=fovx, idxs=np.asarray(idxs), d_ground=dg,
                                    pts=pts_s, pcount=pcnt, prgb=prgb)
                log("  [win %3d] 点云 %d 点/帧（中位）  总 %.1f 万点" % (
                    wi, int(np.median(pcnt)) if len(pcnt) else 0, len(pts_s) / 1e4))
            else:
                np.savez_compressed(cf, c2w=c2w, fov_x=fovx, idxs=np.asarray(idxs), d_ground=dg)
            log("  [win %3d] %3d 帧  DA3 %.1fs (%.2fs/帧) 显存 %.2fGB" % (
                wi, len(idxs), time.time() - t0, (time.time() - t0) / len(idxs),
                (__import__("torch").cuda.max_memory_allocated() / 1e9) if __import__("torch").cuda.is_available() else 0))
        # ---- 用 MoGe 的相机高给这个窗定尺度：MoGe 跨帧尺度一致，而 DA3 每个窗的世界尺度不同
        # （实测相邻窗差 30%）。把每个窗的平移按 s_w = median|d_moge| / median|d_da3| 缩放后，
        # 所有窗都落在 MoGe 尺度上，窗间只剩刚体关系，拼接不再病态。
        mtag = args.mtag or args.tag
        dms = []
        ks = np.full(len(idxs), np.nan)
        # 关键结论（实测）：DA3 的相机高在窗内只抖 2%，MoGe 抖 27%~48% ⇒ MoGe 单帧尺度不可信，
        # 必须用 DA3 的稳定地面高把每帧的 MoGe 尺度归一（k_i = d_da3 / |d_moge|）。
        if args.cache:
            for j, k in enumerate(idxs):
                p = os.path.join(args.cache, "%s-%s.npz" % (mtag, os.path.splitext(files[k])[0]))
                if not os.path.exists(p):
                    continue
                try:
                    v = abs(float(np.load(p)["d"]))
                except Exception:
                    continue
                if not (np.isfinite(v) and v > 1e-6):
                    continue
                dms.append(v)
                dv = abs(float(dg[j])) if np.isfinite(dg[j]) else np.nan
                if np.isfinite(dv) and dv > 1e-6:
                    ks[j] = dv / v
        dgs = np.asarray([abs(float(x)) for x in dg if np.isfinite(x) and abs(float(x)) > 1e-6])
        s_w = None
        if args.norm_moge and len(dms) >= 4 and len(dgs) >= 4:
            s_w = float(np.median(dms)) / float(np.median(dgs))
            if not (0.05 < s_w < 20):
                s_w = None
        dg_raw = np.asarray(dg, np.float64).copy()
        if s_w is not None:
            c2w[:, :3, 3] *= s_w
            dg = np.asarray(dg, np.float64) * s_w
            log("  [win %3d] 按 MoGe 尺度归一 %.5f（MoGe 相机高 %.4f / DA3 %.4f）" % (
                wi, s_w, float(np.median(dms)) if dms else -1.0, float(np.median(dgs)) if len(dgs) else -1.0))
        results.append({"wi": wi, "keys": list(idxs), "c2w": c2w, "fov_x": fovx,
                        "d_ground": np.asarray(dg, np.float64), "d_ground_raw": dg_raw,
                        "k_scale": ks, "scale_moge": s_w})
    log("[pose] DA3 阶段用时 %.0fs" % (time.time() - t_all))

    # ---- 窗口拼接：以第一个窗为全局基准，逐窗 Sim3 对齐
    centers = [r["c2w"][:, :3, 3] for r in results]
    G = [np.eye(4)]
    fits = []
    for i in range(1, len(results)):
        prev, cur = results[i - 1], results[i]
        common = sorted(set(prev["keys"]) & set(cur["keys"]))
        if len(common) < 4:
            log("  [stitch] 窗 %d/%d 重叠只有 %d 帧，退化用上一窗的 Sim3" % (i - 1, i, len(common)))
            G.append(G[-1].copy())
            fits.append({"pair": [i - 1, i], "n_common": len(common), "scale": 1.0, "res_p50": -1})
            continue
        pi = {k: j for j, k in enumerate(prev["keys"])}
        ci = {k: j for j, k in enumerate(cur["keys"])}
        src = np.array([cur["c2w"][ci[k]][:3, 3] for k in common])
        dst = np.array([prev["c2w"][pi[k]][:3, 3] for k in common])
        # 各窗已被 MoGe 尺度归一（scale_moge）⇒ 窗间只剩刚体关系。
        # 首选：用重叠帧的**点云**直接解窗间尺度（同一帧两窗只差深度尺度，最稳）。
        # 次选：用两边 DA3 地面高之比定尺度，再只解刚体；再不行才解带尺度 Sim3。
        s_cloud = None
        za = zb = offa = offb = None
        if args.save_points:
            ia = {k: j for j, k in enumerate(prev["keys"])}
            ib = {k: j for j, k in enumerate(cur["keys"])}
            pa = os.path.join(args.out, "%s-win%03d.npz" % (args.tag, prev["wi"]))
            pb = os.path.join(args.out, "%s-win%03d.npz" % (args.tag, cur["wi"]))
            if os.path.exists(pa) and os.path.exists(pb):
                s_cloud = cloud_scale_between(pa, pb, ia, ib, common)
                if args.stitch_mode == "orient":
                    za, offa = npz_frames(pa)
                    zb, offb = npz_frames(pb)
        # 旋转：优先用重叠帧的相机**朝向**（Wahba）。相机中心在沿路直行时几乎共线，
        # 只靠中心解 Umeyama 会让「绕行进轴的滚转」完全病态 —— 实测相邻窗 up 轴能差
        # 13~70°，这正是世界不水平、点云成薄片的根因。
        if args.stitch_mode == "orient":
            Ra_ = np.array([orthonormalize(prev["c2w"][pi[k]][:3, :3]) for k in common])
            Rb_ = np.array([orthonormalize(cur["c2w"][ci[k]][:3, :3]) for k in common])
            R_w = wahba_rotations(Rb_, Ra_)
        else:
            R_w = None
        if prev.get("scale_moge") and cur.get("scale_moge"):
            s, R, t, res = umeyama_sim3(src, dst, with_scale=False)
            s, how = 1.0, "rigid"
        elif R_w is not None:
            if s_cloud is not None:
                s, how = s_cloud, "orient+cloud"
            else:
                gp = np.array([prev["d_ground"][pi[k]] for k in common], np.float64)
                gc = np.array([cur["d_ground"][ci[k]] for k in common], np.float64)
                mm = np.isfinite(gp) & np.isfinite(gc) & (np.abs(gp) > 1e-6) & (np.abs(gc) > 1e-6)
                s_h = float(np.median(gp[mm]) / np.median(gc[mm])) if mm.sum() >= 4 else None
                s, how = (s_h if (s_h is not None and 0.3 < s_h < 3.0) else 1.0), "orient+ground"
            R = R_w
            t = dst.mean(0) - s * (R @ src.mean(0))
            res = np.linalg.norm((s * (R @ src.T)).T + t - dst, axis=1)
            # 再用点云精修 (s,t)：相机平移量在窗间并不与深度同尺度，只有点云重合才是真判据
            if za is not None:
                ref = refine_window_similarity(za, offa, zb, offb, ia, ib, common, R, s, t)
                if ref is not None:
                    s2, t2, rmed, inl = ref
                    if np.isfinite(rmed) and 0.3 < s2 < 3.0:
                        d_shift = float(np.linalg.norm(t2 - t))
                        if d_shift < 0.5 and abs(np.log(s2 / s)) < 0.5:
                            log("  [stitch] 窗 %2d -> %2d  点云精修 Δs %+.4f  Δt %.4f  重合 p50 %.5f  内点 %.0f%%"
                                % (i - 1, i, s2 - s, d_shift, rmed, 100 * inl))
                            s, t = s2, t2
                            how += "+refine"
                            res = np.linalg.norm((s * (R @ src.T)).T + t - dst, axis=1)
        elif s_cloud is not None:
            s, R, t, res = umeyama_sim3(s_cloud * src, dst, with_scale=False)
            s, how = s_cloud, "cloud"
        else:
            gp = np.array([prev["d_ground"][pi[k]] for k in common], np.float64)
            gc = np.array([cur["d_ground"][ci[k]] for k in common], np.float64)
            mm = np.isfinite(gp) & np.isfinite(gc) & (np.abs(gp) > 1e-6) & (np.abs(gc) > 1e-6)
            s_h = float(np.median(gp[mm]) / np.median(gc[mm])) if mm.sum() >= 4 else None
            if s_h is not None and 0.3 < s_h < 3.0:
                s, R, t, res = umeyama_sim3(s_h * src, dst, with_scale=False)
                s, how = s_h, "ground"
            else:
                s, R, t, res = umeyama_sim3(src, dst, with_scale=True)
                s, how = float(np.clip(s, 0.5, 2.0)), "sim3"
        S = sim3_to_se3(s, R, t)
        G.append(G[-1] @ S)
        fits.append({"pair": [i - 1, i], "n_common": len(common), "scale": round(float(s), 5),
                     "scale_from": how, "res_p50": round(float(np.median(res)), 4), "res_max": round(float(res.max()), 4)})
        log("  [stitch] 窗 %2d -> %2d  重叠 %2d 帧  scale %.5f (%s)  残差 p50 %.4f" % (
            i - 1, i, len(common), s, how, float(np.median(res))))
    json.dump(fits, open(os.path.join(args.out, "%s-stitch.json" % args.tag), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # ---- 关键帧全局位姿（后出现的窗覆盖前面的，重叠处取平均权重的后窗）
    key_pose = {}
    key_dg = {}
    key_k = {}
    key_ws = {}
    for r, Gi in zip(results, G):
        ws = float(np.cbrt(abs(np.linalg.det(Gi[:3, :3]))))     # 该窗被拼接时的累积尺度（相似变换的 s）
        for j, k in enumerate(r["keys"]):
            T = Gi @ r["c2w"][j]
            if k in key_pose:
                key_pose[k] = 0.5 * (key_pose[k] + T)      # 简单平均，避免边界跳变
            else:
                key_pose[k] = T
            d = float(r["d_ground"][j]) if r.get("d_ground") is not None else float("nan")
            if k not in key_dg or not np.isfinite(key_dg.get(k, np.nan)):
                key_dg[k] = d
            kk_ = float(r["k_scale"][j]) if r.get("k_scale") is not None else float("nan")
            if np.isfinite(kk_):
                key_k[k] = kk_ if k not in key_k else 0.5 * (key_k[k] + kk_)
            key_ws[k] = ws
    kk = sorted(key_pose)
    kk_s = sorted(key_k)

    def frame_scale(i):
        """每帧的 MoGe->全局 尺度：k（DA3 地面高归一，压掉 MoGe 单帧尺度抖动）× 该窗的拼接累积尺度"""
        if not kk_s:
            return 1.0
        lo = max([k for k in kk_s if k <= i], default=kk_s[0])
        hi = min([k for k in kk_s if k >= i], default=kk_s[-1])
        if lo == hi:
            kk_ = float(key_k[lo])
        else:
            a = (i - lo) / float(hi - lo)
            kk_ = float((1 - a) * key_k[lo] + a * key_k[hi])
        return kk_ * float(key_ws.get(lo) or key_ws.get(hi) or 1.0)
    log("[pose] 关键帧全局位姿 %d 个（覆盖 %d~%d）" % (len(kk), kk[0], kk[-1]))

    # ---- 插值到所有帧
    poses = []
    for i in range(n):
        lo = max([k for k in kk if k <= i], default=kk[0])
        hi = min([k for k in kk if k >= i], default=kk[-1])
        if lo == hi:
            T = key_pose[lo]
            src = "da3"
        else:
            a = (i - lo) / float(hi - lo)
            T0, T1 = key_pose[lo], key_pose[hi]
            c = (1 - a) * T0[:3, 3] + a * T1[:3, 3]
            R = R_from_quat(slerp(quat_from_R(T0[:3, :3]), quat_from_R(T1[:3, :3]), a))
            T = np.eye(4)
            T[:3, :3] = R
            T[:3, 3] = c
            src = "interp"
        W = w2c_from_c2w(T)
        poses.append({"idx": i, "file": files[i], "key": (i in key_pose), "src": src,
                      "c2w": [round(float(x), 7) for x in T.reshape(-1)],
                      "R": [[round(float(x), 7) for x in row] for row in W[:3, :3]],
                      "t": [round(float(x), 7) for x in W[:3, 3]]})

    out = {"tag": args.tag, "dir": args.dir, "fps": args.fps, "key_step": args.key_step,
           "win": args.win, "stride": args.stride, "frames": n, "n_keys": len(kk),
           "convention": "c2w_xright_yup_zback(da3_normalized)",
           "up_axis": "y", "down_vector": [-0.0388, 0.1776, -0.9833],
           "scale_moge": [round(float(r.get("scale_moge") or 1.0), 6) for r in results],
           "key_d_ground": {str(k): key_dg.get(k) for k in kk},
           "frame_scale": [round(frame_scale(i), 7) for i in range(n)],
           "stitch": fits, "poses": poses}
    json.dump(out, open(os.path.join(args.out, "%s-pose.json" % args.tag), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    json.dump({"tag": args.tag, "fps": args.fps, "frames": [{"R": p["R"], "t": p["t"], "key": p["key"]} for p in poses]},
              open(os.path.join(args.out, "%s-render-poses.json" % args.tag), "w", encoding="utf-8"),
              ensure_ascii=False)
    # 轨迹自检图（俯视，看是否沿路走）
    C = np.array([key_pose[k][:3, 3] for k in kk])
    log("[pose] 关键帧轨迹跨度 %s，总长 %.3f，起点 %s" % (
        np.round(C.max(0) - C.min(0), 3).tolist(), float(np.linalg.norm(np.diff(C, axis=0), axis=1).sum()),
        np.round(C[0], 3).tolist()))
    log("[pose] 落盘 %s-pose.json / -render-poses.json" % args.tag)


if __name__ == "__main__":
    main()
