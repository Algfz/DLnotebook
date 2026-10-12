#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
音乐结构分析 —— 让 AI「看见」音乐内容。

AI 听不到声音，但能读懂分析出的数字与形状。本脚本输出：
  - 段落划分（起止时间、能量、亮度、音符密度）
  - 时间轴上的 ASCII 曲线（能量 / 亮度 / 音符密度）—— 可直接看出起伏形状
  - 音符起始点（onset）列表
  - 主音高轮廓（旋律走向）
结果同时写入同目录的 music-analysis.json。

用法：
  python tools/analyze-music.py                 # 分析 levels/ 下最近修改的音频
  python tools/analyze-music.py <音频文件路径>
"""
import os, sys, json, glob, subprocess, tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import find_peaks

SR = 22050          # 分析用采样率（足够覆盖钢琴音域，且快）
FRAME = 2048
HOP = 512
WIN_SEC = 0.5       # 每个统计窗口的时长


# ---------------------------------------------------------------- 输入输出
def find_audio():
    cands = []
    for d in sorted(glob.glob('levels/*')):
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.lower().endswith(('.mp3', '.wav', '.ogg', '.m4a', '.flac')):
                cands.append(os.path.join(d, f))
    if not cands:
        return None
    cands.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return cands[0]


def decode(path):
    """用 ffmpeg 转成单声道低采样率 wav"""
    out = os.path.join(tempfile.gettempdir(), '_dl_music.wav')
    subprocess.run(
        ['ffmpeg', '-y', '-i', path, '-ac', '1', '-ar', str(SR), out],
        capture_output=True
    )
    return out


# ---------------------------------------------------------------- 特征计算
def features(x, sr):
    n = len(x)
    times, rms, centroid, pitch = [], [], [], []
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sr)
    band = (freqs > 60) & (freqs < 4000)        # 钢琴主要能量区间

    for i in range(0, n - FRAME, HOP):
        seg = x[i:i + FRAME] * np.hanning(FRAME)
        spec = np.abs(np.fft.rfft(seg))
        times.append((i + FRAME / 2) / sr)
        rms.append(float(np.sqrt(np.mean(seg ** 2))))
        centroid.append(float(np.sum(freqs[band] * spec[band]) / (np.sum(spec[band]) + 1e-9)))
        # 主音高：频带内最大峰对应的频率
        j = np.argmax(spec[band])
        pitch.append(float(freqs[band][j]))

    return (np.array(times), np.array(rms), np.array(centroid), np.array(pitch))


def onsets(rms, times, sr):
    """音符起始：能量包络的上升沿"""
    env = rms.copy()
    env = env / (env.max() + 1e-9)
    d = np.diff(env)
    d[d < 0] = 0
    dist = max(1, int(0.07 / (HOP / sr)))       # 至少间隔 70ms
    peaks, _ = find_peaks(d, height=float(np.std(d)) * 0.8, distance=dist)
    return times[peaks + 1]


def segments(times, rms, centroid, onsets_per_sec, total):
    """按特征变化点切段"""
    w = max(1, int(WIN_SEC / (HOP / SR)))
    nw = len(rms) // w
    if nw < 4:
        return [(0.0, total)]
    r = rms[:nw * w].reshape(nw, w).mean(1)
    c = centroid[:nw * w].reshape(nw, w).mean(1)
    o = onsets_per_sec[:nw * w].reshape(nw, w).mean(1)

    r = (r - r.min()) / (r.max() - r.min() + 1e-9)
    c = (c - c.min()) / (c.max() - c.min() + 1e-9)
    o = (o - o.min()) / (o.max() - o.min() + 1e-9)

    feat = np.stack([r, c, o], 1)
    nov = np.linalg.norm(np.diff(feat, axis=0), axis=1)
    # 平滑后找峰
    k = 5
    ker = np.ones(k) / k
    nov_s = np.convolve(nov, ker, 'same')
    peaks, _ = find_peaks(nov_s, height=float(np.mean(nov_s) + np.std(nov_s) * 0.6),
                          distance=max(2, int(8 / WIN_SEC)))
    bounds = [0.0] + [float(times[p * w]) for p in peaks] + [total]
    return list(zip(bounds[:-1], bounds[1:]))


def spark(vals, chars='▁▂▃▄▅▆▇█'):
    """把序列画成 ASCII 柱状图，便于直接看出形状"""
    v = np.asarray(vals, dtype=float)
    if len(v) == 0:
        return ''
    v = (v - v.min()) / (v.max() - v.min() + 1e-9)
    return ''.join(chars[min(len(chars) - 1, int(x * len(chars)))] for x in v)


# ---------------------------------------------------------------- 主流程
def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_audio()
    if not path or not os.path.exists(path):
        print('找不到音频文件')
        return 1

    print('=' * 64)
    print('音乐结构分析')
    print('=' * 64)
    print('文件: ' + path)

    wav = decode(path)
    sr, x = wavfile.read(wav)
    x = x.astype(np.float32)
    if x.ndim > 1:
        x = x.mean(1)
    x = x / (np.max(np.abs(x)) + 1e-9)
    total = len(x) / sr
    print(f'时长: {total:.2f}s   采样率: {sr}')

    times, rms, centroid, pitch = features(x, sr)
    on = onsets(rms, times, sr)

    # 每秒的音符密度
    dens = np.zeros(len(times))
    idx = np.searchsorted(times, on)
    idx = idx[idx < len(times)]
    np.add.at(dens, idx, 1)
    k = int(1.0 / (HOP / sr))
    ker = np.ones(k)                   # 一秒窗口内求和 = 每秒音符数
    dens_s = np.convolve(dens, ker, 'same')

    segs = segments(times, rms, centroid, dens_s, total)

    # ---------------- 段落表 ----------------
    print('\n段落:')
    print('  #  时间            时长    能量    亮度(Hz)  音符/秒  主音高(Hz)')
    rows = []
    for i, (a, b) in enumerate(segs, 1):
        m = (times >= a) & (times < b)
        if m.sum() == 0:
            continue
        e = float(rms[m].mean())
        c = float(centroid[m].mean())
        p = float(np.median(pitch[m]))
        o = float(dens_s[m].mean())
        rows.append({'i': i, 't': [round(a, 2), round(b, 2)],
                     'energy': round(e, 4), 'brightness': round(c, 1),
                     'notes_per_sec': round(o, 2), 'pitch_hz': round(p, 1)})
        print(f'  {i:<2}  {a:6.1f}–{b:6.1f}s  {b-a:5.1f}s  {e:.4f}  {c:8.0f}  {o:7.2f}  {p:9.0f}')

    # ---------------- ASCII 曲线 ----------------
    print('\n形状（每格约 %.1f 秒，左→右为时间）:' % (total / 60))
    print('  能量 ' + spark(np.interp(np.linspace(0, len(rms) - 1, 60),
                                      np.arange(len(rms)), rms)))
    print('  亮度 ' + spark(np.interp(np.linspace(0, len(centroid) - 1, 60),
                                      np.arange(len(centroid)), centroid)))
    print('  音符 ' + spark(np.interp(np.linspace(0, len(dens_s) - 1, 60),
                                      np.arange(len(dens_s)), dens_s)))
    print('  音高 ' + spark(np.interp(np.linspace(0, len(pitch) - 1, 60),
                                      np.arange(len(pitch)), pitch)))

    # ---------------- 峰值 ----------------
    print('\n最响的 5 个时刻:')
    top = np.argsort(rms)[-200:]
    cl = [float(times[i]) for i in top]
    cl.sort()
    grp, cur = [], [cl[0]]
    for t in cl[1:]:
        if t - cur[-1] < 2.0:
            cur.append(t)
        else:
            grp.append(cur); cur = [t]
    grp.append(cur)
    for g in grp[-5:]:
        print(f'  {sum(g)/len(g):6.1f}s')

    print(f'\n音符起始点: {len(on)} 个（前 30 个）')
    print('  ' + ' '.join(f'{t:.2f}' for t in on[:30]))

    out = os.path.join(os.path.dirname(path), 'music-analysis.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({
            'audio': os.path.basename(path), 'duration': round(total, 2),
            'onsets': [round(float(t), 3) for t in on],
            'segments': rows,
        }, f, ensure_ascii=False, indent=1)
    print('\n已写入: ' + out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
