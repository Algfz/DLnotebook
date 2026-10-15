#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用本地 VLM（Qwen2.5-VL-3B-Instruct）审阅渲染帧。

为什么写这个：发起人肉眼能在截图上看出"这块方块太大、离路太远"，
而 Agent 只能拿到"撞帧 0 / 偏差 0.013m"这类可测量代理指标。
本机已装好 torch 2.11+cu128 + transformers + bitsandbytes + qwen-vl-utils，
并且模型权重就在本地（C:\\D\\QQMoniter\\models\\Qwen2.5-VL-3B-Instruct），
所以可以让模型自己"看"渲染图，试着补上"看不见"这一环。

用法（必须用装了依赖的那个解释器）：
  C:\\Users\\abc\\.conda\\envs\\QQMoniter\\python.exe tools/vlm-review.py \
      --prompt-file out/tmp/prompt.txt out/tmp/a.jpg out/tmp/b.jpg
  ... --compare out/tmp/a.jpg out/tmp/b.jpg     # 两张一起给，让它比较

模型用 4bit 量化加载（权重约 2.4GB 显存），8GB 显存够用。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

MODEL_DEFAULT = r"C:\D\QQMoniter\models\Qwen2.5-VL-3B-Instruct"

PROMPT_DEFAULT = """这是一张 3D 躲避类游戏关卡的截图，白色的是玩家要走的路。
请只根据你确实看到的内容回答，看不清就写"看不清"，不要脑补：
1) 沿白色路面看，路面两侧每个转弯处附近，是否都有紧贴路边放置的方块？
2) 有没有哪一段路边完全空着、没有任何方块？
3) 有没有方块明显比周围其他方块大很多，或者离路面很远、孤零零地立在远处？
请用画面方位（左/右/上/下/近处/远处）指出具体位置。"""

PROMPT_COMPARE = """下面两张图是同一个游戏关卡的同一处场景，改造前和改造后。
白色的是玩家要走的路，蓝色方块是路边的障碍物。
请比较两张图，回答：
1) 哪一张图里的方块更紧贴路面、更贴合路的走向？
2) 哪一张图里有"明显太大"或者"离路面太远"的方块？请指出在哪个位置。
3) 如果你只能保留一张，你会保留哪一张？为什么？
只根据你确实看到的回答，看不清就写"看不清"。"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--prompt-file", default=None)
    ap.add_argument("--compare", action="store_true",
                    help="把所有图片放进同一次对话，让模型比较")
    ap.add_argument("--max-pixels", type=int, default=1280 * 28 * 28)
    ap.add_argument("--max-new-tokens", type=int, default=600)
    args = ap.parse_args()

    for p in args.images:
        if not p.exists():
            print(f"[error] 找不到图片：{p}", file=sys.stderr)
            return 2

    if args.prompt_file:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    elif args.prompt:
        prompt = args.prompt
    else:
        prompt = PROMPT_COMPARE if args.compare else PROMPT_DEFAULT

    # 延迟导入：这样 --help 不需要加载 torch
    import torch
    from transformers import (AutoProcessor, BitsAndBytesConfig,
                              Qwen2_5_VLForConditionalGeneration)
    from qwen_vl_utils import process_vision_info

    t0 = time.time()
    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_quant_type="nf4",
    )
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        args.model,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
        device_map={"": 0},
    )
    processor = AutoProcessor.from_pretrained(args.model)
    print(f"[vlm] 模型加载完成 {time.time() - t0:.1f}s", flush=True)

    content: list[dict] = []
    for i, p in enumerate(args.images):
        if len(args.images) > 1:
            content.append({"type": "text", "text": f"图 {i + 1}（{p.name}）："})
        content.append({"type": "image", "image": str(p),
                        "max_pixels": args.max_pixels})
    content.append({"type": "text", "text": prompt})

    messages = [{"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False,
                                         add_generation_prompt=True)
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(text=[text], images=image_inputs, videos=video_inputs,
                       padding=True, return_tensors="pt").to(model.device)

    t1 = time.time()
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=args.max_new_tokens,
                             do_sample=False)
    trimmed = [o[len(i):] for i, o in zip(inputs.input_ids, out)]
    answer = processor.batch_decode(trimmed, skip_special_tokens=True,
                                    clean_up_tokenization_spaces=False)[0]
    print(f"[vlm] 推理 {time.time() - t1:.1f}s", flush=True)
    print("=" * 60)
    print(answer.strip())
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
