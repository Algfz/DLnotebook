"""《驻足的宁静》布景读图（俯视临摹）—— 左＝原片帧，右＝按帧临摹的俯视平面。
★ 两条硬规则（发起人 2026-10-13 指出）：
   1) 路只朝**两个**方向延伸（本关＝+x 与 +z），所以平面图上它是一条从**一角走到对角**的阶梯，
      绝不来回摆（我上一版画成左右摇摆的蛇形是错的）。
   2) 俯视图整幅也按"一角 → 对角"来铺，不是从左到右。
输出 out/etw-layout.svg → out/etw-layout.png
用法：python tools/etw-layout.py
"""
W = 2.9
OUT = r"out/etw-layout.svg"
PAD = 40
FRAME_W, FRAME_H = 540, 304
ROW_H = 520
o = []
def add(s): o.append(s)


def road_diag(legs, leg, u0, v0):
    """只朝 +u / +v 两个方向延伸：一段 +v、一段 +u、再 +v…（阶梯 → 对角）。"""
    pts, u, v = [(u0, v0)], u0, v0
    for i in range(legs):
        if i % 2 == 0:
            v += leg
        else:
            u += leg
        pts.append((u, v))
    return pts


def plan_panel(x0, y0, wn, hn, scale, road_pts, blocks, note, ladder=None):
    px, py = wn * scale, hn * scale
    add(f'<rect x="{x0}" y="{y0}" width="{px:.0f}" height="{py:.0f}" fill="#f4f1e6" stroke="#d6d0bd"/>')
    add('<g stroke="#e6e0cf" stroke-width="1">')
    for i in range(wn + 1):
        add(f'<line x1="{x0+i*scale:.1f}" y1="{y0}" x2="{x0+i*scale:.1f}" y2="{y0+py:.0f}"/>')
    for j in range(hn + 1):
        add(f'<line x1="{x0}" y1="{y0+j*scale:.1f}" x2="{x0+px:.0f}" y2="{y0+j*scale:.1f}"/>')
    add('</g>')

    def X(u): return x0 + u * scale
    def Y(v): return y0 + py - v * scale
    pts = " ".join(f"{X(u):.1f},{Y(v):.1f}" for (u, v) in road_pts)
    add(f'<polyline points="{pts}" fill="none" stroke="#a8b8d8" stroke-width="{scale:.1f}" stroke-linejoin="miter"/>')
    add(f'<polyline points="{pts}" fill="none" stroke="#c0c79d" stroke-width="{scale*0.3:.1f}" stroke-linejoin="miter"/>')
    pal = ["#3f5286", "#657cbe", "#7f95cf"]
    for grp in ([blocks] + ([ladder] if ladder else [])):
        for (u, v, side, tone) in grp:
            w = side * scale
            add(f'<rect x="{X(u)-w/2:.1f}" y="{Y(v)-w/2:.1f}" width="{w:.1f}" height="{w:.1f}" fill="{pal[tone]}" stroke="#2b3550" stroke-width="1"/>')
    sb = y0 + py + 28
    add(f'<line x1="{x0}" y1="{sb}" x2="{x0+2*scale:.1f}" y2="{sb}" stroke="#2b3550" stroke-width="5"/>')
    add(f'<text x="{x0+2*scale+12:.1f}" y="{sb+7}" font-size="19" fill="#2b3550">2W = {2*W:.1f} m　（方格 = 1W）</text>')
    add(f'<text x="{x0}" y="{sb+32}" font-size="19" fill="#4a5470">{note}</text>')


LEG = 1.15

# ① 平原：贴路一列 0.55W 小方块（垂直于每一段、两侧都有）＋ 两翼散落大平板
road1 = road_diag(9, LEG, 1.2, 1.2)
ladder1 = []
for i in range(9):
    if i % 2 == 0:      # 这一段朝 +v → 左右在 ±u
        ladder1 += [(road1[i][0] - 0.95, road1[i][1] + LEG / 2, 0.55, 2),
                    (road1[i][0] + 0.95, road1[i][1] + LEG / 2, 0.55, 2)]
    else:               # 这一段朝 +u → 左右在 ±v
        ladder1 += [(road1[i][0] + LEG / 2, road1[i][1] - 0.95, 0.55, 2),
                    (road1[i][0] + LEG / 2, road1[i][1] + 0.95, 0.55, 2)]
scatter1 = [(0.6, 3.4, 1.9, 0), (5.0, 1.3, 2.2, 1), (2.6, 6.6, 1.5, 1), (7.4, 4.2, 2.6, 0),
            (4.2, 8.3, 2.0, 1), (8.3, 7.0, 1.2, 2), (0.7, 6.0, 1.3, 2), (3.1, 3.0, 1.0, 2),
            (6.4, 8.6, 1.7, 0), (1.4, 8.4, 2.4, 1), (8.6, 2.4, 1.4, 2), (6.2, 5.6, 1.1, 2)]

# ② 方块立起来：整片密铺成网格，只沿对角留一条 ~2.6W 的走廊给路
road2 = road_diag(9, LEG, 1.2, 1.2)
grid2 = []
for j in range(12):
    for i in range(12):
        u = 0.75 + i * 1.05
        v = 0.75 + j * 1.05
        if abs(u - v) < 2.6:            # 到对角线的垂直距离（路从 (1.2,1.2) 起沿 x−y=0）
            continue
        grid2.append((u, v, 0.9 + 0.12 * ((i * 3 + j * 5) % 3), (i * 2 + j) % 3))

# ③ 走廊：沿对角的两道长墙
road3 = road_diag(9, LEG, 1.2, 1.2)
walls3 = []
for k in range(6):
    d = 1.2 + k * LEG + LEG / 2
    walls3 += [(d - 1.85, d, 1.25, 1), (d + 1.85, d, 1.25, 0),
               (d, d - 1.85, 1.25, 1), (d, d + 1.85, 1.25, 0)]

H_TOTAL = 1900
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="1420" height="{H_TOTAL}" font-family="\'Noto Sans SC\',\'Microsoft YaHei\',system-ui,sans-serif">')
add(f'<rect width="1420" height="{H_TOTAL}" fill="#fbfaf6"/>')
add(f'<text x="{PAD}" y="58" font-size="38" font-weight="700" fill="#1e2740">《驻足的宁静》(ETW29) · 布景俯视临摹</text>')
add(f'<text x="{PAD}" y="96" font-size="20" fill="#4a5470">左＝原片抽帧；右＝按帧临摹的俯视图。<tspan font-weight="700">路只朝两个方向（+x / +z）延伸</tspan>，所以图上是一条从<tspan font-weight="700">一角走到对角</tspan>的阶梯；整幅平面也按这个方向铺。</text>')
add(f'<text x="{PAD}" y="126" font-size="20" fill="#4a5470">长度单位＝路宽 W（W = 2.9 m），每格 1W。人工临摹：原片是透视画面，比例靠路面宽度当尺子量。</text>')

SEC = [("① 平原 · 散落石板（t≈8s）", "ref_etw/frames/f008.jpg", road1, scatter1, ladder1,
        "路＝+v/+u 交替的阶梯（每段 1.15W）；贴着路一列 0.55W 小方块；两翼散落 0.9~2.9W 平板"),
       ("② 方块立起来（t≈30s）", "ref_etw/frames/f030.jpg", road2, grid2, None,
        "全部抬起、密铺成网格（0.9~1.4W）；只沿路留一条 ~2.6W 走廊 —— 路面是被方块围出来的"),
       ("③ 走廊 · 路在槽底（t≈75s）", "ref_etw/frames/f075.jpg", road3, walls3, None,
        "两侧沿路合成连续长墙（宽 1.25W、高 2~10W、离路 ~1.85W）；1W 的路落在槽底")]

y = 160
for title, img, road, blocks, ladder, note in SEC:
    add(f'<text x="{PAD}" y="{y+26}" font-size="26" font-weight="600" fill="#1e2740">{title}</text>')
    add(f'<image x="{PAD}" y="{y+42}" width="{FRAME_W}" height="{FRAME_H}" href="{img}"/>')
    add(f'<rect x="{PAD}" y="{y+42}" width="{FRAME_W}" height="{FRAME_H}" fill="none" stroke="#c9c4b4"/>')
    plan_panel(PAD + FRAME_W + 60, y + 26, 12, 9, 38, road, blocks, note, ladder)
    y += ROW_H

add(f'<text x="{PAD}" y="{y+26}" font-size="26" font-weight="600" fill="#1e2740">③ 的横断面（从帧里读出的关系）</text>')
bx, by, bw, bh = PAD, y + 42, 1100, 200
add(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" fill="#f4f1e6" stroke="#d6d0bd"/>')
gy = by + bh - 36
add(f'<rect x="{bx+60}" y="{gy-150}" width="70" height="150" fill="#8fa0c8" stroke="#2b3550"/>')
add(f'<rect x="{bx+190}" y="{gy-14}" width="300" height="14" fill="#a8b8d8" stroke="#2b3550"/>')
add(f'<rect x="{bx+550}" y="{gy-210}" width="90" height="210" fill="#8fa0c8" stroke="#2b3550"/>')
add(f'<text x="{bx+62}" y="{gy+28}" font-size="19" fill="#2b3550">墙（这一侧较矮）</text>')
add(f'<text x="{bx+250}" y="{gy+28}" font-size="19" fill="#2b3550">路面＝槽底（低 2~10W）</text>')
add(f'<text x="{bx+556}" y="{gy+28}" font-size="19" fill="#2b3550">墙（另一侧更高）</text>')
add(f'<text x="{bx+700}" y="{gy-110}" font-size="20" fill="#4a5470">墙面到路中心 ≈ 1.8W；顶上没有天、只有雾</text>')
add(f'<text x="{bx+700}" y="{gy-80}" font-size="20" fill="#4a5470">—— 这就是它"没有地平线"的做法。</text>')
add('</svg>')
open(OUT, "w", encoding="utf8").write("\n".join(o))
print("→", OUT)
