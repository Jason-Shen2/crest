#!/usr/bin/env python3
"""Quantize the fine-tuned ONNX classifier to int8.

Fine-tuned BERT/MiniLM exported as fp32 ONNX comes out at ~460 MB.
For a browser-loaded model that's unworkable.  Dynamic int8 weight
quantization typically gets us to ~60-80 MB with negligible accuracy
loss for sentence-classification tasks.

Output: training/onnx_model/model_quantized.onnx alongside the fp32
model.  crest's worker loads the quantized file.
"""

import json
from pathlib import Path

import numpy as np
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoTokenizer

ROOT = Path(__file__).parent
ONNX_DIR = ROOT / "onnx_model"
FP32 = ONNX_DIR / "model.onnx"
INT8 = ONNX_DIR / "model_quantized.onnx"

# Same probe set as finetune_classifier.py.  After quantization we re-run
# them against the int8 model to catch any quality regression — we only
# ship the quantized file if it still passes.
PROBE_SET = [
    ("ls -la", "shell"),
    ("git status", "shell"),
    ("rm -rf /tmp/foo", "shell"),
    ("npm install", "shell"),
    ("docker compose up -d", "shell"),
    ("what does ls -la do", "ai"),
    ("how do I list files", "ai"),
    ("hello", "ai"),
    ("thanks", "ai"),
    ("ls -la 是什么意思", "ai"),
    ("git status 怎么用", "ai"),
    ("怎么列出当前目录下的文件", "ai"),
    ("ls -la means what?", "ai"),
    ("git rebase 是干嘛的", "ai"),
    ("can you explain rm -rf for me", "ai"),
]

MAX_LENGTH = 64


def main():
    if not FP32.exists():
        raise SystemExit(f"fp32 model missing: {FP32} — run finetune_classifier.py first")

    fp32_size_mb = FP32.stat().st_size / 1024 / 1024
    print(f"fp32 model: {fp32_size_mb:.1f} MB")

    print("dynamic int8 quantization ...")
    # weight_type=QInt8 produces signed int8 weights — supported well by
    # onnxruntime-web's WASM backend.  Dynamic (rather than static)
    # avoids needing a calibration dataset.
    quantize_dynamic(
        model_input=str(FP32),
        model_output=str(INT8),
        weight_type=QuantType.QInt8,
    )

    int8_size_mb = INT8.stat().st_size / 1024 / 1024
    print(f"int8 model: {int8_size_mb:.1f} MB ({int8_size_mb / fp32_size_mb * 100:.0f}% of fp32)")

    print("\nverifying quantized model on probe set ...")
    from onnxruntime import InferenceSession

    sess = InferenceSession(str(INT8), providers=["CPUExecutionProvider"])
    tokenizer = AutoTokenizer.from_pretrained(str(ONNX_DIR))

    fail = 0
    for text, expected in PROBE_SET:
        enc = tokenizer(
            text,
            truncation=True,
            padding="max_length",
            max_length=MAX_LENGTH,
            return_tensors="np",
        )
        inputs = {
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64),
        }
        # Some BERT exports also expect token_type_ids — feed zeros if so.
        input_names = {i.name for i in sess.get_inputs()}
        if "token_type_ids" in input_names:
            inputs["token_type_ids"] = np.zeros_like(enc["input_ids"]).astype(np.int64)

        logits = sess.run(None, inputs)[0][0]
        # softmax
        e = np.exp(logits - logits.max())
        probs = e / e.sum()
        p_ai = float(probs[1])
        verdict = "ai" if p_ai > 0.5 else "shell"
        flag = "✓" if verdict == expected else "✗"
        if verdict != expected:
            fail += 1
        print(f"  {flag} pAI={p_ai:.3f} expected={expected:5s} got={verdict:5s} | {text}")

    if fail:
        print(f"\n⚠️  {fail}/{len(PROBE_SET)} probes failed after quantization.")
        print("Consider sticking with fp32 or trying a different quantization mode.")
    else:
        print(f"\n✓ all {len(PROBE_SET)} probes pass on int8 model")
        # fp32 is huge — only keep int8 for shipping.
        # Don't delete the fp32 here automatically; it's useful for re-quant.


if __name__ == "__main__":
    main()
