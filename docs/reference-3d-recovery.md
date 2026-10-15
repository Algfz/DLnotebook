# 从演示视频反推场景（路线 B：本地度量重建）

> 目标：把官方关卡的演示视频帧，变成**可测量的三维坐标**——道路在哪、方块多大、离路多远，
> 最终对齐到我们自己关卡的参数空间（`place`: t / off / w / d / h），形成"参考帧 ↔ 参数"的闭环。
> 背景与方案调研见 `docs/reference-video-to-scene.md`；本文件只记录**已跑通的东西与实测精度**。

## 1. 本机可行性与环境

| 项 | 值 |
|---|---|
| GPU | RTX 5060 Laptop 8 GB（sm_120，驱动 616.92） |
| 解释器 | `C:\Users\abc\.conda\envs\comfyui\python.exe`（torch 2.11.0+cu128，`cuda.is_available()=True`） |
| 模型 | MoGe-2 ViT-L `C:\DLnotebook-media\models\Ruicheng__moge-2-vitl-normal\model.pt`（1.32 GB） |
| 代码 | `C:\DLnotebook-media\tools\MoGe`（`git clone --depth 1`，`moge/model/v2.py`） |
| 单帧耗时 | 模型加载 ~10 s + 推理 ~25~40 s（1024 px，fp16，`num_tokens=2200`） |

**依赖坑（踩过）**：PyPI 的 `utils3d` 缺少 `utils3d.pt` ⇒ `AttributeError: module 'utils3d' has no attribute 'pt'`；
必须装 MoGe `pyproject.toml` 指定的 fork `utils3d_moge @ git+https://github.com/EasternJournalist/utils3d-moge.git@62f09d58`
（`moge/model/v2.py` 顶层 `try: import utils3d_moge as utils3d`）。

**网络坑（踩过）**：HF 大文件 302 到带签名的 Xet CDN；`huggingface.co` 与 `us.aws.cdn.hf.co` 都必须在
`C:\D\DLnotebook\.dsh\rules.yaml` 里放行；`curl.exe`（走 Windows 证书库）能连，
Python `requests`（走 certifi）会 `CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain`
⇒ 权重一律 `curl -C -` 续传，不要改 Python 证书配置。

## 2. 工具 `tools/refscene.py`

```
python tools/refscene.py --image <帧> --tag <前缀> [--max-side 1024] [--num-tokens 2200] [--no-viz]
```

流程：
1. MoGe-2 → 逐像素 `points`（相机系 x 右 / y 下 / z 前，度量）、`depth`、`normal`、`intrinsics`、`mask`。
2. **世界"上"方向** = 法线图里"最接近水平面法线"的主聚类（`scipy.cluster.vq.kmeans2`，k=8，取 `|n·y|` 最大簇，
   再用 ±20° 内点求均值；相机 y 向下 ⇒ up 与 −y 同向）。
3. **水平主轴** = 竖直面（法线 ⊥ up）方位角直方图峰值 → `e1`，`e2 = up × e1`。
4. **最低显著水平面** = 水平面高度直方图的第一个显著峰（相机原点为 0）。
5. **平板提取** = 按"朝上的面"（`|n·up| > 0.85`）分层 → 每层在水平面内做 2D 连通域 → 每块 = 一个可见顶面，
   记 `size_e1_e2_up` / `level_top_m` / `height_m`；长宽比 ≥ 4 的判为"细长条（疑似道路）"。
6. 输出：`<tag>.json`、`<tag>-boxes.png`（把每个盒重投影回原图 = **肉眼校验**）、`-points.ply`、
   `-depth.png`、`-normal.png`、`-top.png`、`-side.png`。

## 3. 实测精度（有真值：我们自己的引擎 + 已知机位）

真值来源：`node tools/shot.js --level "ring a bell" --times 22 --w 1280 --h 720` → `out/shot/ring a bell-灰澈/t22s.jpg`。
引擎机位（`src/js/game.js:58-62`）：`CAM_OFF = {x:-17, y:21, z:-17}` ⇒ 距离 32.1、俯角 41.1°、`fov = 55°`（垂直）。
把引擎世界坐标换到 MoGe 相机系，**真值 up = (0, −0.7530, −0.6544)**。

| 量 | 真值 | 反推值 | 误差 |
|---|---|---|---|
| 世界 up（相机系） | (0, −0.753, −0.654) | (0.000, −0.782, −0.623) | **4.7°** |
| 垂直 FOV | 55.0° | 62.9°（fx 470.6px @1024 宽） | −15% 焦距 ⇒ FOV 偏大 |
| 场景整体尺度 | — | 中位深度 8.12 m（真实 32 单位） | **绝对尺度不可信** |
| 块尺寸（可见顶面） | 1.27~1.51、2.40~2.80（单位） | 1.10~1.25、1.70~1.80（m 的相对量） | 动态范围被压缩，**约 ±30%** |

`out/tmp/ref-scene/own-t22-boxes.png`：红色线框**基本套住**画面里的方块 ⇒ 主轴与相对几何是对的。

官方帧（`ref_official2\空间\g0252.jpg`，1024×576）：up = (−0.033, −0.681, −0.732)（俯角 ≈47°）、
相机在最低显著水平面上方 4.27 m、可见顶面 17 块；但 `space-g0252-boxes.png` 里边框相对画面**明显转了角度**，
说明这一帧的水平主轴 `e1` 估得不准（法线聚类在官方美术风格 + 大俯角下不稳）。

## 4. 已知限制与下一步

**限制**
1. 绝对尺度不可信（单目度量模型的先验）⇒ 一切尺寸必须用**已知长度归一化**（最自然是路宽 W）。
2. FOV 偏大 ~15% ⇒ 不要用 MoGe 的内参做度量，只用于重投影自检。
3. 水平主轴在官方帧上不稳（→ 线框转角）；可见顶面被遮挡 ⇒ 尺寸偏小。
4. 单帧 = 单视角；看不到的面只能"看不清"。

**下一步（按性价比排序）**
1. **灭点定主轴**：用方块棱线的曼哈顿灭点求水平主轴，替掉法线聚类；再用"线框与图像边缘的对齐度"做一次小优化。
2. **多帧融合**：同一关取 N 帧（`g*.jpg` 是游戏内跟随相机帧），用 MoGe-2 的相机/点云做一致性拼接，得整关布局。
3. **路宽 W 提取**：把"细长条"（道路）打通，用它的宽度做尺度基准 ⇒ 尺寸直接以 W 为单位，与我们的报告口径一致。
4. **闭环**：把反推出的 `(尺寸, off, 间距)` 写成 `place` 表，用我们引擎同机位回渲 → 与参考帧并排比对，迭代到像。
