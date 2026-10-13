"""《驻足的宁静》布景读图（俯视临摹）—— 左＝原片帧，右＝按帧临摹的俯视平面。
输出 out/etw-layout.svg → out/etw-layout.png
用法：python out/_etw_layout.py
"""
W = 2.9
OUT = r"out/etw-layout.svg"
PAD = 40
FRAME_W, FRAME_H = 560, 315
ROW_H = 560
o = []
def add(s): o.append(s)


def X(u, x0, wn, scale): return x0 + wn * scale / 2 + u * scale
def Y(v, y0, hn, scale): return y0 + hn * scale - v * scale


def plan_panel(x0, y0, wn, hn, scale, road_pts, blocks, note):
    add(f'<rect x="{x0}" y="{y0}" width="{wn*scale:.0f}" height="{hn*scale:.0f}" fill="#f4f1e6" stroke="#d6d0bd"/>')
    add('<g stroke="#e6e0cf" stroke-width="1">')
    for i in range(wn + 1):
        add(f'<line x1="{x0+i*scale:.1f}" y1="{y0}" x2="{x0+i*scale:.1f}" y2="{y0+hn*scale:.0f}"/>')
    for j in range(hn + 1):
        add(f'<line x1="{x0}" y1="{y0+j*scale:.1f}" x2="{x0+wn*scale:.0f}" y2="{y0+j*scale:.1f}"/>')
    add('</g>')
    pts = " ".join(f"{X(u,x0,wn,scale):.1f},{Y(v,y0,hn,scale):.1f}" for (u, v) in road_pts)
    add(f'<polyline points="{pts}" fill="none" stroke="#a8b8d8" stroke-width="{scale:.1f}" stroke-linejoin="miter"/>')
    add(f'<polyline points="{pts}" fill="none" stroke="#c0c79d" stroke-width="{scale*0.3:.1f}" stroke-linejoin="miter"/>')
    pal = ["#3f5286", "#657cbe", "#7f95cf"]
    for (u, v, side, tone) in blocks:
        w = side * scale
        add(f'<rect x="{X(u,x0,wn,scale)-w/2:.1f}" y="{Y(v,y0,hn,scale)-w/2:.1f}" width="{w:.1f}" height="{w:.1f}" fill="{pal[tone]}" stroke="#2b3550" stroke-width="1"/>')
    sb = y0 + hn * scale + 30
    add(f'<line x1="{x0}" y1="{sb}" x2="{x0+2*scale:.1f}" y2="{sb}" stroke="#2b3550" stroke-width="5"/>')
    add(f'<text x="{x0+2*scale+12:.1f}" y="{sb+7}" font-size="19" fill="#2b3550">2W = {2*W:.1f} m　（方格 = 1W）</text>')
    add(f'<text x="{x0}" y="{sb+34}" font-size="19" fill="#4a5470">{note}</text>')


def road_stair(u0, v0, legs, leg=1.15, amp=1.0):
    pts = [(u0 + amp / 2, v0 - leg / 2)]
    u, v, sgn = u0 + amp / 2, v0, -1
    for _ in range(legs):
        u += sgn * amp
        pts.append((u, v))
        v += leg
        pts.append((u, v))
        sgn = -sgn
    return pts


blocks1 = []
for i in range(7):
    v = 0.6 + i * 1.15
    blocks1.append((0.78 if i % 2 else -0.78, v, 0.55, 2))
blocks1 += [(-2.6, 1.4, 1.1, 1), (2.4, 2.2, 0.9, 0), (-3.9, 3.2, 2.1, 1), (4.2, 3.6, 1.6, 0),
            (-2.2, 4.3, 1.3, 2), (3.0, 5.0, 2.4, 1), (-5.1, 4.4, 1.8, 0), (5.3, 5.6, 2.9, 1),
            (-3.4, 6.2, 2.2, 0), (2.1, 6.6, 1.2, 2), (4.6, 7.0, 1.9, 1), (-6.0, 2.6, 1.4, 2),
            (6.2, 2.0, 1.2, 0), (-4.6, 7.4, 1.5, 2)]

blocks2 = []
for j in range(7):
    v = 0.5 + j * 1.05
    for i in range(-5, 6):
        u = i * 1.05 + (0.52 if j % 2 else -0.52)
        if abs(u) < 1.25:
            continue
        blocks2.append((u, v, 0.92 + 0.1 * ((i * 3 + j * 5) % 3), (i * 2 + j) % 3))
for i in range(5):
    blocks2.append(((2.4 if i % 2 else -2.4) + (0.5 if i % 3 else 0), 1.2 + i * 1.3, 1.35, 1))

walls3 = []
for i in range(6):
    for s in (-1, 1):
        walls3.append((s * 1.85, 0.8 + i * 1.2, 1.25, 1))

H_TOTAL = 1980
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="1420" height="{H_TOTAL}" font-family="\'Noto Sans SC\',\'Microsoft YaHei\',system-ui,sans-serif">')
add(f'<rect width="1420" height="{H_TOTAL}" fill="#fbfaf6"/>')
add(f'<text x="{PAD}" y="58" font-size="38" font-weight="700" fill="#1e2740">《驻足的宁静》(ETW29) · 布景俯视临摹</text>')
add(f'<text x="{PAD}" y="96" font-size="21" fill="#4a5470">左＝原片抽帧；右＝我按帧临摹的俯视图。长度单位一律用"路宽 W"（W = 2.9 m）。</text>')
add(f'<text x="{PAD}" y="126" font-size="21" fill="#8a3f2f">这是人工临摹，不是像素级反推：原片是透视画面，也没有官方平面图，比例靠路面宽度当尺子量。</text>')
add(f'<text x="{PAD}" y="158" font-size="20" fill="#4a5470">三段读法：① 平原：一列小方块（0.55W）贴着路，外围散落 0.9~2.9W 的平板；② 方块立起来：全部抬升、密铺成网格，只在路两侧各留一条走道；③ 走廊：两侧合成沿路长墙，路落到槽底。</text>')

SEC = [("① 平原 · 散落石板（t≈8s）", "ref_etw/frames/f008.jpg", blocks1,
        "路＝90° 阶梯（每段 1.15W），贴着一列 0.55W 小方块；外围散落 0.9~2.9W 平板"),
       ("② 方块立起来（t≈30s）", "ref_etw/frames/f030.jpg", blocks2,
        "方块抬升并密铺成网格（0.9~1.4W），路两侧各留 ~1.25W 走道"),
       ("③ 走廊 · 路在槽底（t≈75s）", "ref_etw/frames/f075.jpg", walls3,
        "两侧合成沿路长墙（宽 1.25W、高 2~10W），路宽 1W 在槽底")]

y = 190
for title, img, blocks, note in SEC:
    add(f'<text x="{PAD}" y="{y+26}" font-size="26" font-weight="600" fill="#1e2740">{title}</text>')
    add(f'<image x="{PAD}" y="{y+42}" width="{FRAME_W}" height="{FRAME_H}" href="{img}"/>')
    add(f'<rect x="{PAD}" y="{y+42}" width="{FRAME_W}" height="{FRAME_H}" fill="none" stroke="#c9c4b4"/>')
    plan_panel(PAD + FRAME_W + 70, y + 42, 13, 8, 44, road_stair(0, 0.4, 7), blocks, note)
    y += ROW_H

# 段③ 横断面
add(f'<text x="{PAD}" y="{y+26}" font-size="26" font-weight="600" fill="#1e2740">③ 的横断面（从帧里读出的关系）</text>')
bx, by, bw, bh = PAD, y + 42, 1100, 210
add(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" fill="#f4f1e6" stroke="#d6d0bd"/>')
gy = by + bh - 40
add(f'<rect x="{bx+60}" y="{gy-170}" width="70" height="170" fill="#8fa0c8" stroke="#2b3550"/>')
add(f'<rect x="{bx+190}" y="{gy-14}" width="300" height="14" fill="#a8b8d8" stroke="#2b3550"/>')
add(f'<rect x="{bx+550}" y="{gy-230}" width="90" height="230" fill="#8fa0c8" stroke="#2b3550"/>')
add(f'<text x="{bx+70}" y="{gy+30}" font-size="19" fill="#2b3550">墙（近处矮）</text>')
add(f'<text x="{bx+250}" y="{gy+30}" font-size="19" fill="#2b3550">路面＝槽底（低 2~10W）</text>')
add(f'<text x="{bx+560}" y="{gy+30}" font-size="19" fill="#2b3550">墙（远处高）</text>')
add(f'<text x="{bx+710}" y="{gy-100}" font-size="20" fill="#4a5470">墙面到路中心 ≈ 1.8W；墙高 2~10W（越近越高是因为近处的墙本来就更高）；</text>')
add(f'<text x="{bx+710}" y="{gy-70}" font-size="20" fill="#4a5470">顶上没有天，只有雾 —— 这也是"没有地平线"的做法。</text>')
add('</svg>')
open(OUT, "w", encoding="utf8").write("\n".join(o))
print("→", OUT)
