# 从演示视频反推场景（方法调研）

> 触发：发起人问「有没有一种方法，能通过关卡的演示视频，直接反推出一个大致的场景信息？」（m13827）
> 以及「你要不要去查一查，这样的事有没有一些比较好的方案？」（m13830）
> 调研时间：2026-10-15。以下均为外部方案，未在本仓库落地。

## 0. 结论先行

- 2025–2026 这一波「前馈几何基础模型」已经把「几张/几百张画面 → 相机 + 稠密几何」做成了
  **一次前向推理**，不需要 COLMAP 式的 SfM 优化。对我们这种**纯色、无纹理、有雾**的合成画面，
  这是好消息：传统 SfM 会因特征点太少而退化。
- 但「稠密几何 → 我们关卡里的 `place[]`（长方体 + 参数）」这一半没有现成的一体化方案，
  需要自己拼。对口的工作有 Cube R-CNN/Omni3D（单图 3D box）、Point2CAD（点云分面 + 基元拟合）、
  CAD-Recode（点云 → 可执行参数化程序）。
- **我们有一件别人没有的东西：自己复刻的引擎。** 所以可以走「分析即合成」
  （analysis-by-synthesis）：按候选参数渲染、与原帧逐像素比对、迭代。域差为零，
  而且能无限生成 (图, `place`) 训练对。

## 1. 分层方案

### 第 1 层：相机与尺度

| 方案 | 能给出什么 | 备注 / 链接 |
| --- | --- | --- |
| VGGT | 1/几张/几百张视图 → 相机参数、point map、深度、3D 点轨迹 | CVPR 2025 **最佳论文**，[arXiv 2503.11651](https://arxiv.org/abs/2503.11651)、[github](https://github.com/facebookresearch/vggt)、[项目页](https://vgg-t.github.io) |
| VGGT-Ω (1B/10B) | VGGT 后续，相机 AUC 明显更高 | 见 CVPR 2026 前馈 3D/4D 综述表 |
| DUSt3R / MASt3R | 两视图 → 点图 + 位姿 | [github.com/naver/dust3r](https://github.com/naver/dust3r) |
| MapAnything | **度量尺度**几何 + 相机；可接受已知内参/位姿/深度/部分重建等灵活输入 | Meta，[arXiv 2509.13414](https://arxiv.org/html/2509.13414v2)、[github](https://github.com/facebookresearch/map-anything)、[项目页](https://map-anything.github.io) |
| Depth Anything 3 | 任意视角 → 视觉空间（位姿 + 几何） | 2025.11，[arXiv 2511.10647](https://arxiv.org/abs/2511.10647)，比 VGGT 位姿 +35.7%、几何 +23.6% |
| MoGe / MoGe-2 / MoGe-3 | **单图** → 度量 point map / 深度 / 法线 / FOV | Microsoft Research，CVPR'25 Oral，[github](https://github.com/microsoft/moge)、MoGe-2 [arXiv 2507.02546](https://arxiv.org/html/2507.02546v1) |
| fSpy | 单图灭点 → 相机（位置/朝向/焦距） | 用「画面里一个已知实尺」定尺度 —— 正是我们的**路宽 W**：[fspy.io/basics](https://fspy.io/basics) |

对纯色平面的补充：灭点法（fSpy / 曼哈顿世界）只依赖**平行边**这一强先验，
比依赖特征点匹配的通用 SfM 更稳，适合作为尺度标定的第一步。

### 第 2 层：把几何切成「元件」

| 方案 | 能给出什么 | 备注 / 链接 |
| --- | --- | --- |
| Cube R-CNN + Omni3D | **单图**检测带朝向的 3D box（位置/尺寸/朝向） | Meta，234k 图 / 3M 个标注；优于 Total3D、ImVoxelNet，[arXiv 2207.10660](https://arxiv.org/html/2207.10660v2)、[项目页](https://garrickbrazil.com/omni3d) |
| Point2CAD | 点云 → 分面聚类 → 几何基元/参数曲面拟合 | CVPR 2024，[项目页](https://www.obukhov.ai/point2cad) |
| CAD-Recode | 点云 → **可执行的参数化程序**（CadQuery Python） | ICCV 2025，[arXiv 2412.14042](https://arxiv.org/abs/2412.14042)、[github](https://github.com/filaPro/cad-recode)、[项目页](https://cad-recode.github.io)；训练集＝**100 万程序化生成**的 CAD 程序 |

CAD-Recode 与我们要的「点云/深度 → `place[]`」是**同构问题**，而且它的训练数据配方
（程序化生成程序）我们完全能自造：引擎里 `place[]` → 渲染，天然是 (参数, 图) 对。

### 第 3 层：视频级一致性

- video_to_world：几何基础模型 + 非刚性对齐，把不一致的多视图深度对齐成一个世界
  （[项目页](https://lukashoel.github.io/video_to_world)、[github](https://github.com/lukasHoel/video_to_world)）
- NeuralRecon：单目视频 → 实时连贯 3D 重建（[项目页](https://zju3dv.github.io/neuralrecon)）
- StreamVGGT 等流式/4D 变体见 [Awesome-3D-Reconstruction-and-Generation](https://github.com/PolySummit/Awesome-3D-Reconstruction-and-Generation)
- 3DGS / NeRF 类：保外观很在行，但**不给参数化元件**，对我们「要改关卡」的目标帮助有限

## 2. 三条落地路线（按性价比排序）

**路线 A｜几何辅助半人工（半天~2 天，建议先做）**
灭点 + 路宽 W 标定相机 → 手工框 5~10 个方块 → 解 3D → 用我们引擎按解出的参数回渲 → 与原帧并排。
验收 = 路面反投影吻合 + 方块边缘对齐。目的不是全关自动化，而是**第一次建立
「参考帧 ↔ 我们的 `place` 参数」的闭环**，把「太大太远」变成可算的**屏幕角径**。

**路线 B｜基础模型 + 基元拟合（1~2 周）**
MoGe-2 / VGGT-Ω / MapAnything 出度量点云 → RANSAC 轴对齐长方体拟合 → 输出 `place` 候选 →
我们引擎回渲 diff 迭代。风险：合成画面纯色无纹理，模型可能有 5~15% 系统偏差；
缓解办法是把我们的渲染加噪声/压缩后喂给它（domain randomization），或直接把已知内参/位姿
当作输入（MapAnything、VGGT 都支持）来降低难度。

**路线 C｜仿 CAD-Recode 自训「图 → 程序」小模型（工程量最大）**
训练数据用我们引擎程序化生成（百万级免费、域差为零）；推理时用路线 B 的度量点云兜底。
一旦成立，就是「任意关卡演示视频 → 场景草案」。

## 3. 边界与风险（必须写明）

- 遮挡、出入画、雾与过曝段只能标「看不清」——只能还原**看得见的部分**。
- 反推出的是**几何草案**：位置/尺寸/朝向。**设计意图与审美仍然要人来定**。
  这与我们上一轮的结论一致：数据给分布，不给结论。
- 尺度是最大隐患：单目度量模型给出的米数需要一次校准；我们的路宽 W 是现成的标尺。

## 4. 与我们现有流程的关系

现在的研究流程是「看图 → 写描述 → 抽规则 R1~R25 → 在自己关卡重新实现」——
**单向、无闭环**，验收标准是「报告写得对不对」而不是「做出来像不像」。
上面任一条路线都能补上缺的那一环：**同机位回渲 + 与参考帧并排比对**。

参考：`docs/reference-study-method.md`（现行研究方法）。
