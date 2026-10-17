"""reffuse2.py — 用**真位姿**（refpose.py 的 DA3-Giant 多视图锚点）做加权体素融合

与旧的 reffuse.py 的区别（旧版被用户评为"点云太粗糙"）：
  旧：帧间 2D 相似变换链式累积（LK 光流）→ 长距离漂移 → 体素降采样 + 随机抽稀（噪声不平均）
  新：DA3-Giant 关键帧真位姿（窗口 Sim3 拼接）→ 每帧再用 **带尺度的 ICP** 对全局模型精配准
      → 点按体素做**加权平均**（TSDF 风格），表面被平均平滑、重影被压掉
另：MoGe 每帧尺度不完全一致，ICP 的 Sim3 顺带把每帧尺度也解出来（--scale 给初值）。

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\reffuse2.py --dir <帧目录> --tag desert-s1 --cache <npz> --pose <tag>-pose.json --out <out> --max-frames 60
  python tools\\reffuse2.py ... --icp-iters 0            # 关掉 ICP 做对照（量位姿本身的贡献）
"""
import argparse
import importlib.util
import json
import math
import os
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(*a, flush=True)


def load_refscene():
    spec = importlib.util.spec_from_file_location("refscene", os.path.join(HERE, "refscene.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def pack_key(P, v):
    k = np.floor(P / v).astype(np.int64) + (1 << 20)
    np.clip(k, 0, (1 << 21) - 1, out=k)
    return (k[:, 0] << 42) | (k[:, 1] << 21) | k[:, 2]


def quat_from_R(R):
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    q = np.asarray(q, np.float64)
    return q / np.linalg.norm(q)


def umeyama_sim3(src, dst, with_scale=True, trim=2.0, iters=3):
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    s, R, t = 1.0, np.eye(3), np.zeros(3)
    res = np.zeros(len(src))
    for _ in range(iters):
        if len(src) < 3:
            break
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
        if len(res) <= 20:
            break
        keep = res <= max(trim * float(np.median(res)), 1e-12)
        if keep.all():
            break
        src, dst = src[keep], dst[keep]
    return s, R, t, res


class Acc(object):
    """稀疏体素累加器：帧内先聚合，再与全局按 key 归并（加权平均）"""

    def __init__(self, v):
        self.v = v
        self.key = np.zeros(0, np.int64)
        self.sp = np.zeros((0, 3), np.float64)
        self.sc = np.zeros((0, 3), np.float64)
        self.w = np.zeros(0, np.float64)
        self.n = np.zeros(0, np.int32)

    def add(self, P, C, W):
        if len(P) == 0:
            return
        k = pack_key(P, self.v)
        ku, inv = np.unique(k, return_inverse=True)
        m = len(ku)
        sp = np.zeros((m, 3)); sc = np.zeros((m, 3)); w = np.zeros(m); n = np.zeros(m, np.int32)
        np.add.at(sp, inv, P * W[:, None])
        np.add.at(sc, inv, C.astype(np.float64) * W[:, None])
        np.add.at(w, inv, W)
        np.add.at(n, inv, 1)
        key = np.concatenate([self.key, ku])
        sp = np.concatenate([self.sp, sp]); sc = np.concatenate([self.sc, sc])
        w = np.concatenate([self.w, w]); n = np.concatenate([self.n, n])
        o = np.argsort(key, kind="stable")
        key, sp, sc, w, n = key[o], sp[o], sc[o], w[o], n[o]
        first = np.ones(len(key), bool)
        first[1:] = key[1:] != key[:-1]
        idx = np.flatnonzero(first)
        self.key = key[idx]
        self.sp = np.add.reduceat(sp, idx, axis=0)
        self.sc = np.add.reduceat(sc, idx, axis=0)
        self.w = np.add.reduceat(w, idx)
        self.n = np.add.reduceat(n, idx)

    def cloud(self, min_n=1):
        mm = self.n >= min_n
        w = np.maximum(self.w[mm], 1e-12)
        return self.sp[mm] / w[:, None], np.clip(self.sc[mm] / w[:, None], 0, 255)


def main_da3(args):
    """从 refpose --save-points 的窗口 npz 里直接取 **DA3 多视图点云**做加权体素融合。

    为什么这条路可能更干净：实测 MoGe 单帧的"相机到地面距离"逐帧抖 27%~48%（尺度/形状都在抖），
    而 DA3 在同一个多视图窗内只抖 1.6%~2.8% ⇒ 用 MoGe 点云 + DA3 位姿时，每帧云本身形状不一致，
    融合必然被抹开（俯视图成扇形）。DA3 自己的点云按构造就是多视图自洽的。
    """
    from scipy.spatial import cKDTree
    rs = load_refscene()
    pj = json.load(open(args.from_da3, encoding="utf-8"))
    poses = {int(p["idx"]): np.asarray(p["c2w"], np.float64).reshape(4, 4) for p in pj["poses"]}
    keys = sorted(int(k) for k in pj.get("key_d_ground", {}).keys())
    # 只有真是 DA3 关键帧（有实测位姿）的帧才能用：中间帧的位姿是从关键帧插值出来的，
    # 若把它们也喂进来，超出关键帧覆盖范围的帧会拿到被夹到端点的那份位姿 ⇒ 点全部堆在一处。
    key_set = set(keys)
    # ICP 守卫标尺：DA3 关键帧之间的真实步长（中位）。实测无守卫时 umeyama 最近邻会在
    # 近平面稀疏云上给出离谱刚体解，把相机甩出 3.4 单位（步长中位的 90 倍）。
    _C = [poses[k][:3, 3] for k in keys if k in poses]
    step_med = float(np.median(np.linalg.norm(np.diff(np.stack(_C), axis=0), axis=1))) if len(_C) > 1 else 0.02
    # 只吃**本 tag 自己**的窗口：窗口目录里可能同时躺着其它 tag 的 npz（例如同目录下的
    # desert-s2/s3），它们的 idxs 同样是 0~N 的全局帧号，会被 poses/key_set 过滤放过，
    # 于是把别人的点云按本段的位姿塞进世界 ⇒ 满屏彩色碎点、体素数暴涨（实测 1155 帧/92M 点）。
    # 窗口前缀取 pose json 里的 tag（refpose --tag），而不是输出 tag（可能是 --tag desert-s1o）。
    wt = str(pj.get("tag") or args.tag)
    prefix = wt + "-win"
    wins = sorted(f for f in os.listdir(args.win_dir) if f.startswith(prefix) and f.endswith(".npz"))
    if not wins:
        raise SystemExit("[fuse2-da3] 在 %s 下找不到 %s*.npz（窗口前缀取自 pose json 的 tag=%s）"
                         % (args.win_dir, prefix, wt))
    log("[fuse2-da3] %s: 窗口 %d 个（前缀 %s），关键帧 %d 个，voxel %.4f，ICP %s" % (
        args.tag, len(wins), prefix, len(keys), args.voxel, ("%d 轮" % args.icp_iters) if args.icp_iters else "关"))

    acc = Acc(args.voxel)
    tree = None
    tree_n = -1
    used = refined = 0
    traj, Rref, scales = [], [], []
    diag = 1.0
    t_all = time.time()
    nf = 0
    for wf in wins:
        z = np.load(os.path.join(args.win_dir, wf))
        if "pts" not in z.files:
            continue
        P_all = z["pts"]; C_all = z["prgb"]; cnt = z["pcount"]; idxs = [int(x) for x in z["idxs"]]
        off = 0
        for j, idx in enumerate(idxs):
            n_j = int(cnt[j])
            P = P_all[off:off + n_j].astype(np.float64); C = C_all[off:off + n_j]
            off += n_j
            nf += 1
            if n_j < 50 or idx not in poses or idx not in key_set:
                continue
            rng = np.linalg.norm(P, axis=1)
            keep = (rng > args.min_range) & (rng < args.max_range) & np.isfinite(rng)
            if keep.sum() < 50:
                continue
            P, C, rng = P[keep], C[keep], rng[keep]
            sel = np.arange(len(P))
            if len(P) > args.pts_per_frame:
                sel = np.random.RandomState(1234 + idx).choice(len(P), args.pts_per_frame, replace=False)
            Ps, Cs = P[sel], C[sel]
            T = poses[idx]
            R_cur, t_cur, s_cur = T[:3, :3].copy(), T[:3, 3].copy(), 1.0
            inl = -1
            if args.icp_iters > 0 and tree is not None:
                sub = Ps[::max(1, len(Ps) // args.icp_pts)][:args.icp_pts]
                inl = 0
                for it in range(args.icp_iters):
                    Pw = (R_cur @ sub.T).T + t_cur
                    dist, kk = tree.query(Pw, k=1)
                    thr = args.voxel * (args.icp_thr0 + (args.icp_thr1 - args.icp_thr0) * it / max(1, args.icp_iters - 1))
                    m = dist < thr
                    if m.sum() < args.icp_min_inl:
                        break
                    inl = int(m.sum())
                    s_n, R_n, t_n, _ = umeyama_sim3(sub[m], Qref_da3[kk[m]], with_scale=False, trim=2.0)
                    # 守卫：单步位移 / 旋转有界，且要用「同一批匹配点」的中位残差证明确实变小
                    ang = float(np.arccos(np.clip((np.trace(R_n) - 1.0) / 2.0, -1.0, 1.0)))
                    if np.linalg.norm(t_n) > max(3.0 * args.voxel, 0.25 * step_med) or ang > 0.0087:
                        break
                    R_try = R_n @ R_cur
                    t_try = (R_n @ t_cur) + t_n
                    d0 = float(np.median(dist[m]))
                    d1 = float(np.median(np.linalg.norm(((R_try @ sub[m].T).T + t_try) - Qref_da3[kk[m]], axis=1)))
                    if d1 > d0 * 0.999:
                        break
                    R_cur, t_cur = R_try, t_try
                if inl >= args.icp_min_inl:
                    refined += 1
            Pw = (R_cur @ Ps.T).T + t_cur
            w = np.ones(len(Pw))
            acc.add(Pw, Cs, w)
            used += len(Pw)
            traj.append(t_cur.copy())
            Rref.append(R_cur.copy())
            scales.append(1.0)
            if tree is None or nf - tree_n >= args.kdtree_every:
                Pc, _ = acc.cloud(min_n=1)
                if len(Pc):
                    sel2 = np.arange(len(Pc))
                    if len(Pc) > args.ref_max:
                        sel2 = np.random.RandomState(7).choice(len(Pc), args.ref_max, replace=False)
                    Qref_da3 = Pc[sel2]
                    tree = cKDTree(Qref_da3)
                    tree_n = nf
        if len(traj) > 1:
            diag = float(np.linalg.norm(np.asarray(traj[-1]) - np.asarray(traj[0])))
        Pc, _ = acc.cloud(min_n=1)
        log("  %s  -> 体素 %8d  用点 %9d  已配准 %4d" % (wf, len(Pc), used, refined))
    Pc, Cc = acc.cloud(min_n=args.min_weight)
    log("[fuse2-da3] 融合完成：体素 %d（>=%d 点），用点 %d，用时 %.0fs" % (
        len(Pc), args.min_weight, used, time.time() - t_all))
    stats = {"tag": args.tag, "mode": "da3_points", "frames": nf, "used_points": int(used),
             "refined_frames": int(refined), "voxel": args.voxel, "voxels": int(len(Pc)),
             "min_weight": args.min_weight,
             "bbox": ([float(x) for x in Pc.min(0)] + [float(x) for x in Pc.max(0)]) if len(Pc) else None}
    json.dump(stats, open(os.path.join(args.out, "%s-fuse2.json" % args.tag), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    Tr = np.asarray(traj, np.float64) if traj else np.zeros((0, 3))
    json.dump({"tag": args.tag, "convention": "c2w_xright_yup_zback(da3)", "up_axis": "y", "fps": pj.get("fps", 10.0),
               "frames": len(Tr), "scale": 1.0,
               "X": [round(float(x), 5) for x in Tr[:, 0]], "Y": [round(float(x), 5) for x in Tr[:, 1]],
               "Z": [round(float(x), 5) for x in Tr[:, 2]],
               "path_len": float(np.linalg.norm(np.diff(Tr, axis=0), axis=1).sum()) if len(Tr) > 1 else 0.0},
              open(os.path.join(args.out, "%s-traj2.json" % args.tag), "w", encoding="utf-8"), ensure_ascii=False)
    if len(Pc):
        pl = os.path.join(args.out, "%s-fused2.ply" % args.tag)
        rs.write_ply(pl, Pc.astype(np.float32), Cc.astype(np.uint8))
        log("[fuse2-da3] 落盘 %s （%.1f MB）" % (pl, os.path.getsize(pl) / 1e6))
    log("[fuse2-da3] 统计 %s" % json.dumps(stats, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=None)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--cache", default=None)
    ap.add_argument("--mtag", default=None, help="MoGe 缓存的 tag 前缀（缺省 = --tag；位姿 tag 与缓存 tag 不同时必须给）")
    ap.add_argument("--pose", default=None, help="<tag>-pose.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--voxel", type=float, default=0.01)
    ap.add_argument("--pts-per-frame", type=int, default=45000)
    ap.add_argument("--min-range", type=float, default=0.25)
    ap.add_argument("--max-range", type=float, default=30.0)
    ap.add_argument("--max-h", type=float, default=2.5, help="相对局部地面平面的高度上限（MoGe 单位）")
    ap.add_argument("--max-lat", type=float, default=15.0, help="|u|,|v| 上限（MoGe 单位）")
    ap.add_argument("--scale", type=float, default=0.0, help="MoGe->DA3 全局尺度；0 = 用地面高度自动估")
    ap.add_argument("--icp-iters", type=int, default=None,
                    help="缺省：DA3 点云模式为 0（实测 ICP 会把相机甩飞 3.4 单位），MoGe 模式为 8")
    ap.add_argument("--icp-pts", type=int, default=2500)
    ap.add_argument("--icp-thr0", type=float, default=6.0, help="ICP 首轮最近邻阈值 = thr0 × voxel")
    ap.add_argument("--icp-thr1", type=float, default=2.0, help="ICP 末轮阈值 = thr1 × voxel")
    ap.add_argument("--icp-min-inl", type=int, default=200)
    ap.add_argument("--kdtree-every", type=int, default=4)
    ap.add_argument("--ref-max", type=int, default=250000)
    ap.add_argument("--warmup", type=int, default=6)
    ap.add_argument("--near-weight", type=float, default=1.0, help="0 = 等权；>0 按距离衰减 w=1/(1+(rng/med)^2*near)")
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--min-weight", type=int, default=1)
    ap.add_argument("--no-ply", action="store_true")
    ap.add_argument("--from-da3", default=None, help="改用 DA3 多视图点云：给 <tag>-pose.json 路径")
    ap.add_argument("--win-dir", default=None, help="refpose --save-points 的窗口 npz 目录")
    args = ap.parse_args()
    if args.icp_iters is None:
        args.icp_iters = 0 if args.from_da3 else 8
    mtag = args.mtag or args.tag
    if args.from_da3:
        if not args.win_dir:
            ap.error("--from-da3 需要 --win-dir")
        os.makedirs(args.out, exist_ok=True)
        return main_da3(args)
    if not (args.dir and args.cache and args.pose):
        ap.error("MoGe 模式需要 --dir / --cache / --pose（或改用 --from-da3）")

    from scipy.spatial import cKDTree
    rs = load_refscene()
    os.makedirs(args.out, exist_ok=True)
    pj = json.load(open(args.pose, encoding="utf-8"))
    poses = pj["poses"]
    frame_scale = pj.get("frame_scale") or []
    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith((".jpg", ".png")))
    nf = min(len(files), len(poses))
    if args.max_frames:
        nf = min(nf, args.max_frames)
    log("[fuse2] %s: 帧 %d（位姿 %d），voxel %.4f，ICP %s" % (args.tag, nf, len(poses), args.voxel,
                                                             ("%d 轮" % args.icp_iters) if args.icp_iters else "关"))

    # ---- 尺度初值：DA3 的地面高度 / MoGe 的地面高度
    keydg = pj.get("key_d_ground", {})
    dg = np.array([abs(v) for v in keydg.values() if v is not None and np.isfinite(v)], np.float64)
    mo = []
    for i in range(0, nf, max(1, nf // 40)):
        cf = os.path.join(args.cache, "%s-%s.npz" % (mtag, files[i].rsplit(".", 1)[0]))
        if os.path.exists(cf):
            z = np.load(cf)
            mo.append(abs(float(z["d"])))
    mo = np.array([v for v in mo if np.isfinite(v) and v > 1e-6], np.float64)
    if args.scale > 0:
        s0 = args.scale
        log("[fuse2] 尺度用手动值 %.5f" % s0)
    elif len(dg) and len(mo):
        s0 = float(np.median(dg) / np.median(mo))
        log("[fuse2] 尺度自动：DA3 地面高中位 %.4f / MoGe 地面高中位 %.4f = %.5f" % (
            float(np.median(dg)), float(np.median(mo)), s0))
    else:
        s0 = 1.0
        log("[fuse2] 尺度信息不足，用 1.0")

    acc = Acc(args.voxel)
    tree = None
    tree_n = -1
    used = skipped = refined = 0
    scales, icp_inl, frame_dt = [], [], []
    traj, Rref = [], []
    rng_med = None
    t_all = time.time()
    for i in range(nf):
        cf = os.path.join(args.cache, "%s-%s.npz" % (mtag, files[i].rsplit(".", 1)[0]))
        if not os.path.exists(cf):
            skipped += 1
            continue
        t0 = time.time()
        z = np.load(cf)
        uv = np.asarray(z["uv"], np.float64)
        h = np.asarray(z["h"], np.float64)
        rgb = np.asarray(z["rgb"], np.float64)
        nv = np.asarray(z["n"], np.float64)
        rv = np.asarray(z["r"], np.float64)
        fv = np.asarray(z["f"], np.float64)
        d = float(z["d"])
        d = d if np.isfinite(d) else 0.0
        if len(uv) == 0:
            skipped += 1
            continue
        P = (d + h)[:, None] * nv[None, :] + uv[:, 0:1] * rv[None, :] + uv[:, 1:2] * fv[None, :]
        rng = np.linalg.norm(P, axis=1)
        keep = ((rng > args.min_range) & (rng < args.max_range) & (h < args.max_h) & (h > -1.0) &
                (np.abs(uv[:, 0]) < args.max_lat) & (np.abs(uv[:, 1]) < args.max_lat) & np.isfinite(rng))
        if keep.sum() < 50:
            skipped += 1
            continue
        P, rgb, rng = P[keep], rgb[keep], rng[keep]
        sel = np.arange(len(P))
        if len(P) > args.pts_per_frame:
            sel = np.random.RandomState(1234 + i).choice(len(P), args.pts_per_frame, replace=False)
        Ps, Cs, Rs = P[sel], rgb[sel], rng[sel]

        Pw_pose = np.asarray(poses[i]["c2w"], np.float64).reshape(4, 4)
        # 每帧尺度：MoGe 单帧尺度抖 ±30~50%，用 DA3 的稳定地面高归一得到的 frame_scale 当初值
        s_i = s0
        if frame_scale and i < len(frame_scale) and np.isfinite(frame_scale[i]) and frame_scale[i] > 1e-9:
            s_i = float(frame_scale[i])
        R_cur, t_cur, s_cur = Pw_pose[:3, :3].copy(), Pw_pose[:3, 3].copy(), s_i

        # ---- 带尺度 ICP：把这一帧贴到已经建好的全局模型上
        inl = -1
        if args.icp_iters > 0 and tree is not None:
            sub = Ps[::max(1, len(Ps) // args.icp_pts)][:args.icp_pts]
            inl = 0
            for it in range(args.icp_iters):
                Pw = s_cur * (R_cur @ sub.T).T + t_cur
                dist, idx = tree.query(Pw, k=1)
                thr = args.voxel * (args.icp_thr0 + (args.icp_thr1 - args.icp_thr0) * it / max(1, args.icp_iters - 1))
                m = dist < thr
                if m.sum() < args.icp_min_inl:
                    break
                inl = int(m.sum())
                s_n, R_n, t_n, _ = umeyama_sim3(sub[m], Qref[idx[m]], with_scale=True, trim=2.0)
                if not (0.5 < s_n < 2.0):
                    break
                s_cur = s_n * s_cur
                R_cur = R_n @ R_cur
                t_cur = s_n * (R_n @ t_cur) + t_n
            if inl >= args.icp_min_inl:
                refined += 1
        scales.append(s_cur)
        icp_inl.append(inl)
        traj.append(t_cur.copy())
        Rref.append(R_cur.copy())

        Pw = s_cur * (R_cur @ Ps.T).T + t_cur
        if rng_med is None:
            rng_med = float(np.median(Rs))
        w = np.ones(len(Pw))
        if args.near_weight > 0:
            w = 1.0 / (1.0 + args.near_weight * (Rs / max(rng_med, 1e-6)) ** 2)
        acc.add(Pw, Cs, w)
        used += len(Pw)

        # 参考模型（每隔几帧重建 KD 树，控内存/时间）
        if i >= args.warmup and (tree is None or i - tree_n >= args.kdtree_every):
            Pc, Cc = acc.cloud(min_n=1)
            if len(Pc):
                sel2 = np.arange(len(Pc))
                if len(Pc) > args.ref_max:
                    sel2 = np.random.RandomState(7).choice(len(Pc), args.ref_max, replace=False)
                Qref = Pc[sel2]
                tree = cKDTree(Qref)
                tree_n = i
        frame_dt.append(time.time() - t0)
        if (i + 1) % 50 == 0 or i == nf - 1:
            Pc, _ = acc.cloud(min_n=1)
            log("  [%4d/%4d] 体素 %8d  用点 %9d  跳过 %3d  已配准 %4d  尺度中位 %.4f  %.2fs/帧" % (
                i + 1, nf, len(Pc), used, skipped, refined,
                float(np.median(scales)) if scales else 0.0, float(np.median(frame_dt))))

    Pc, Cc = acc.cloud(min_n=args.min_weight)
    log("[fuse2] 融合完成：体素 %d（>=%d 点），用时 %.0fs" % (len(Pc), args.min_weight, time.time() - t_all))

    # ---- 锐度指标：每帧点到最终表面的距离（越小越"薄"，就是用户说的"粗糙"的量化）
    sharp = []
    if len(Pc):
        ftree = cKDTree(Pc)
        for i in range(0, nf, max(1, nf // 60)):
            cf = os.path.join(args.cache, "%s-%s.npz" % (mtag, files[i].rsplit(".", 1)[0]))
            if not os.path.exists(cf):
                continue
            z = np.load(cf)
            uv = np.asarray(z["uv"], np.float64); h = np.asarray(z["h"], np.float64)
            nv = np.asarray(z["n"], np.float64); rv = np.asarray(z["r"], np.float64); fv = np.asarray(z["f"], np.float64)
            d = float(z["d"]) if np.isfinite(float(z["d"])) else 0.0
            P = (d + h)[:, None] * nv[None, :] + uv[:, 0:1] * rv[None, :] + uv[:, 1:2] * fv[None, :]
            rng = np.linalg.norm(P, axis=1)
            keep = (rng > args.min_range) & (rng < args.max_range) & (h < args.max_h) & (np.abs(uv[:, 0]) < args.max_lat) & (np.abs(uv[:, 1]) < args.max_lat)
            if keep.sum() < 50:
                continue
            Ps = P[keep][::max(1, int(keep.sum()) // 4000)][:4000]
            j = min(i, len(scales) - 1) if scales else 0
            if Rref and len(Rref) > j:
                Pw = scales[j] * (Rref[j] @ Ps.T).T + traj[j]
            else:
                T = np.asarray(poses[i]["c2w"], np.float64).reshape(4, 4)
                Pw = s0 * (T[:3, :3] @ Ps.T).T + T[:3, 3]
            dd, _ = ftree.query(Pw, k=1)
            sharp.append(dd)
        if sharp:
            dd = np.concatenate(sharp)
            log("[fuse2] 锐度（点到表面距离）p50 %.4f  p90 %.4f  p99 %.4f （voxel %.4f）" % (
                float(np.median(dd)), float(np.percentile(dd, 90)), float(np.percentile(dd, 99)), args.voxel))

    stats = {"tag": args.tag, "frames": nf, "used_points": int(used), "skipped": int(skipped),
             "refined_frames": int(refined), "voxel": args.voxel, "voxels": int(len(Pc)),
             "min_weight": args.min_weight, "scale0": float(s0),
             "scale_median": float(np.median(scales)) if scales else None,
             "icp_iters": args.icp_iters, "icp_inlier_p50": (float(np.median([x for x in icp_inl if x > 0])) if any(x > 0 for x in icp_inl) else None),
             "sec_per_frame_p50": float(np.median(frame_dt)) if frame_dt else None,
             "sharp_p50": (float(np.median(np.concatenate(sharp))) if sharp else None),
             "sharp_p90": (float(np.percentile(np.concatenate(sharp), 90)) if sharp else None),
             "bbox": ([float(x) for x in Pc.min(0)] + [float(x) for x in Pc.max(0)]) if len(Pc) else None}
    json.dump(stats, open(os.path.join(args.out, "%s-fuse2.json" % args.tag), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    Tr = np.asarray(traj, np.float64)
    json.dump({"tag": args.tag, "convention": "opencv_c2w", "up": "-y", "fps": pj.get("fps", 10.0),
               "frames": len(Tr), "scale": float(np.median(scales)) if scales else s0,
               "X": [round(float(x), 5) for x in Tr[:, 0]], "Y": [round(float(x), 5) for x in Tr[:, 1]],
               "Z": [round(float(x), 5) for x in Tr[:, 2]],
               "path_len": float(np.linalg.norm(np.diff(Tr, axis=0), axis=1).sum()) if len(Tr) > 1 else 0.0},
              open(os.path.join(args.out, "%s-traj2.json" % args.tag), "w", encoding="utf-8"), ensure_ascii=False)
    if not args.no_ply and len(Pc):
        pl = os.path.join(args.out, "%s-fused2.ply" % args.tag)
        rs.write_ply(pl, Pc.astype(np.float32), Cc.astype(np.uint8))
        log("[fuse2] 落盘 %s （%.1f MB）" % (pl, os.path.getsize(pl) / 1e6))
    log("[fuse2] 统计 %s" % json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
