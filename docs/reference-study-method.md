# 关卡参考素材的采集与逐帧研究方法

这份文档记录**怎么把官方/饭制关卡的演示视频变成可用的设计依据**。起因：我们第一轮
的参考资料大多是竖屏（480×852），两侧布景被裁掉，于是得出了"官方道具很少"的错误结论，
把关卡做成了"粗制滥造"的样子。第二轮改用三个横向 1080P 合集重做，方法固化在这里。

## 1. 素材来源（2026-10 验证可用）

| 合集 | BV / 形式 | 关数 | 规格 |
| --- | --- | --- | --- |
| 官方 | `BV15eEg6vE6s`（Steam 版完美通关演示，62 个分 P） | 62 | 1920×1080，总 7874s |
| 饭制 Explore The World | `BV1oBg96GE9H`（29 个分 P） | 29 | 1920×1080 |
| 饭制 Simply Trace · 简途 | `BV1NSN6e8EMZ` 等，是 `ugc_season` 合集（37 个分 P，**每个分 P 独立 BV**） | 37 | 1920×1080 |

- 集合类（`ugc_season`）要先取 season 的分 P 列表，再**逐个 BV 调 `x/web-interface/view`** 拿 `cid`。
- ⚠️ **不要用分 P 标题判断内容**：ST17「TrapCrow Unity」实际是 **Unity 编辑器录屏**，
  真游戏画面只占右上 305×180（x975~1280, y300~480），其余 76% 是 Hierarchy/Scene 视图。
  照全幅研究会把 18 个不存在的绿色 Trigger gizmo 当美术抄进关卡。
  **每关都要先用 ffprobe 看分辨率 + 读 2~3 帧确认画面构成。**

## 2. 取流（免登录拿到 720P）

```powershell
# 1) 拿 cid（列表页/分P 或 view 接口）
# 2) playurl：这是唯一能免登录拿到 720P 的口子
curl -s "https://api.bilibili.com/x/player/playurl?bvid=$bv&cid=$cid&platform=html5&qn=64&high_quality=1" `
     -H "User-Agent: $ua" -H "Referer: https://www.bilibili.com/" -b out/tmp/cookies.txt
# → data.durl[0].url 是**单文件 MP4**（format: mp4720, quality: 64）= 1280x720
```

- `dash` 那条路在未登录时只给 480P/360P（`accept_quality` 里虽然列着 1080P，但拿不到）。
- `qn=80` 也只返回 64，所以 **64 就是免登录的上限**。
- 下载：`curl -H "User-Agent: ..." -H "Referer: https://www.bilibili.com/" -o _src.mp4 <url>`（要带 Referer）。

## 3. 抽帧与拼图

```powershell
# 1fps 单帧（定位用）+ 10x10 接触表
ffmpeg -v error -y -i _src.mp4 -vf fps=1 -q:v 5 f%03d.jpg
ffmpeg -v error -y -i _src.mp4 -vf "fps=1/4,scale=320:-2,tile=10x5" sheet.jpg
# 判"硬切 / 白闪 / 黑闪 / 整屏变色 / 渐变"时补抽 8~10fps 的 2 秒窗口
ffmpeg -v error -y -ss 41.0 -t 2 -i _src.mp4 -vf "fps=10,scale=320:-2,tile=5x4" x.jpg
```

- 逐帧研究的抽帧密度用 **2fps**（每 0.5s 一帧）；换场处必须补 8~10fps，否则会把
  "4 帧洗白"误判成硬切（Simply Trace 的 ST11 @32.125~32.625s 就是这种）。

## 4. 报告的固定模板（9 节，一字不改）

1. 素材与基本参数（BV/分P/时长/分辨率/帧率/抽帧密度/实际读了多少帧）
2. 逐段表（段号 | 起止秒 | 时长 | 主题材质 | 线色 | 地面主色 | 相机俯角/距离 | 依据帧号）
3. 结构件清单（是什么 | 尺寸（**以路宽 W 为单位**）| 离路多远 | 成列还是散点 | 间距 | 依据帧号）
4. 道具清单与几何配方（外形拆解成基本几何体 + 比例 + 十六进制色）
5. 尺度与留白（同屏大件数、地面占画面比例、留白由什么承担）
6. 相机（俯角/跟距范围、是否分档、换档触发条件）
7. 配色（主色 3~5 个 + BT.601 明度百分比 + 线 vs 地面的明度差）
8. 最值得抄的 3 件 + 不该抄的 1 件（每件写"抄什么、为什么、怎么落到代码里"）
9. 与其他关/官方关的关系

**纪律**：每条结论必须带帧号；看不清就写"看不清"并框定区间，不要猜；
**只允许写 `out/**`**（不碰 `src/`、`levels/`、`tools/`）。

## 5. 汇总与落地

- 每关一份报告 → `out/research/{official2,etw,st}/<关卡名>.md`
- 跨关的规律汇总 → `out/research/规律与差距-第二版.md`：**R1~R25 硬规律 + 速查表 +
  我们关卡的 P0/P1/P2 清单**。规律按"能不能变成参数"筛选，不能落地的描述一律不写。
- 落地时必须回关卡里抽帧验证（`node tools/shot.js`），并记下"试过又回退"的做法：
  例如照"镶边"规律给线加静态黑描边，会因为"轨迹是玩家边走边画、线头之前没有线"而
  变成路中间一条黑色幽灵带，已回退。

## 6. 踩过的坑

- **PowerShell 5.1 读 `.ps1` 必须带 UTF-8 BOM**，否则中文注释按 ANSI 解码 →
  `Unexpected token ')' in expression or statement`。
- **不要用 `Get-Content -Raw | Set-Content` 改文件**：会把 UTF-8 变成 UTF-16，
  于是 `.mjs` 里的 `fs is not defined`。
- 竖屏源的"官方演示"（852×480 那种）是**竖屏内容 + 两侧模糊副本填充**，
  清晰带只有 ~259px，不能用；`BV1u4411k7CM` 是 SBS 3D 双画面，也不能用。
- 素材里可能夹黑底教学卡、UP 主的宣纸边框、录制失误重跑段——抽帧时按比例剔除。
