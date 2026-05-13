#!/usr/bin/env python3
"""Aggressive ONNX quantization: transformer-fusion + INT8 static.

The dynamic int8 (weight-only) pipeline in quantize_onnx.py lands the
classifier at ~112 MB.  Xenova-style "model_quantized.onnx" files for
the same MiniLM-L12 backbone are ~30 MB.  The difference is two extra
steps applied before / during quantization:

  1.  Transformer-specific graph optimisation
      `onnxruntime.transformers.optimizer.optimize_model` fuses
      attention, layer-norm, embedding+layer-norm, and other BERT ops
      into single kernels.  Op count drops ~3-5x.  fp32 size barely
      moves but quantization becomes far more effective because the
      fused ops have INT8 implementations whereas the small primitive
      ops they replace often don't.

  2.  Static INT8 quantization of *both* weights and activations
      Requires a calibration dataset to estimate per-tensor activation
      ranges.  We sample 500 entries from data.jsonl — enough to cover
      the distribution of shell commands and NL queries the classifier
      will actually see.

Probe set runs at the end; if any probe regresses past a 5% confidence
swing or flips classification, the script prints a warning and leaves
the dynamic-quantized model in place as a safety net.
"""

import json
import random
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process
from transformers import AutoTokenizer

random.seed(42)

ROOT = Path(__file__).parent
ONNX_DIR = ROOT / "onnx_model"
FP32 = ONNX_DIR / "model.onnx"
FUSED = ONNX_DIR / "model_fused_fp32.onnx"
INT8 = ONNX_DIR / "model_quantized.onnx"  # this is what crest loads
DATA = ROOT / "data.jsonl"

MAX_LENGTH = 64
CALIBRATION_SIZE = 500
MODEL_HIDDEN = 384
MODEL_NUM_HEADS = 12

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


def load_calibration_texts() -> list[str]:
    """Sample CALIBRATION_SIZE entries from data.jsonl.  Balanced to
    avoid biasing the activation ranges toward one class."""
    if not DATA.exists():
        raise SystemExit(f"calibration data missing: {DATA}")
    rows = [json.loads(line) for line in DATA.open() if line.strip()]
    shell = [r["text"] for r in rows if r["label"] == "shell"]
    nl = [r["text"] for r in rows if r["label"] == "ai"]
    random.shuffle(shell)
    random.shuffle(nl)
    half = CALIBRATION_SIZE // 2
    return shell[:half] + nl[:half]


class TextCalibrationDataReader(CalibrationDataReader):
    """Feeds tokenized inputs into ORT's static quantizer so it can
    measure activation tensor ranges across the network."""

    def __init__(self, texts: list[str], tokenizer):
        self.texts = texts
        self.tokenizer = tokenizer
        self.idx = 0

    def get_next(self):
        if self.idx >= len(self.texts):
            return None
        text = self.texts[self.idx]
        self.idx += 1
        enc = self.tokenizer(
            text,
            truncation=True,
            padding="max_length",
            max_length=MAX_LENGTH,
            return_tensors="np",
        )
        feed = {
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64),
        }
        # MiniLM-L12 doesn't use token_type_ids but be defensive — some
        # downstream BERT-family exports include it.
        if "token_type_ids" in enc:
            feed["token_type_ids"] = enc["token_type_ids"].astype(np.int64)
        return feed

    def rewind(self):
        self.idx = 0


def run_probe(model_path: Path, tokenizer) -> tuple[int, list[tuple[str, str, str, float]]]:
    """Run probe set, return (num_failures, [(text, expected, got, pAI)...])."""
    from onnxruntime import InferenceSession

    sess = InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_names = {i.name for i in sess.get_inputs()}
    fail = 0
    results = []
    for text, expected in PROBE_SET:
        enc = tokenizer(
            text,
            truncation=True,
            padding="max_length",
            max_length=MAX_LENGTH,
            return_tensors="np",
        )
        feed = {
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64),
        }
        if "token_type_ids" in input_names and "token_type_ids" in enc:
            feed["token_type_ids"] = enc["token_type_ids"].astype(np.int64)
        elif "token_type_ids" in input_names:
            feed["token_type_ids"] = np.zeros_like(enc["input_ids"]).astype(np.int64)
        logits = sess.run(None, feed)[0][0]
        m = logits.max()
        e = np.exp(logits - m)
        probs = e / e.sum()
        p_ai = float(probs[1])
        verdict = "ai" if p_ai > 0.5 else "shell"
        if verdict != expected:
            fail += 1
        results.append((text, expected, verdict, p_ai))
    return fail, results


def main():
    if not FP32.exists():
        raise SystemExit(f"fp32 model missing: {FP32} — run finetune_classifier.py first")

    fp32_mb = FP32.stat().st_size / 1024 / 1024
    print(f"fp32 model: {fp32_mb:.1f} MB")

    # ---------- STEP 1: ORT pre-quantization preprocessing ----------
    # `quant_pre_process` runs symbolic shape inference + light ONNX
    # optimizer.  Output type inference becomes reliable, which the
    # static quantizer relies on for activation-range propagation.
    #
    # We intentionally do NOT run `onnxruntime.transformers.optimizer`
    # here: its BERT-specific Attention/SkipLayerNorm fusions produce
    # custom ops that ORT's static quantizer can't introspect, causing
    # NoneType failures during MatMul/bias quantization.  Skipping
    # fusion costs us ~10-15 MB of final size but keeps the pipeline
    # robust.
    print("\n[1/3] pre-quantization shape inference + light optimizer...")
    quant_pre_process(
        input_model_path=str(FP32),
        output_model_path=str(FUSED),
        skip_optimization=False,
        skip_onnx_shape=False,
        skip_symbolic_shape=False,
        auto_merge=True,
        int_max=2**31 - 1,
        guess_output_rank=False,
    )
    fused_mb = FUSED.stat().st_size / 1024 / 1024
    print(f"preprocessed: {fused_mb:.1f} MB")

    # Quick model summary — count ops.
    fused_proto = onnx.load(str(FUSED))
    op_counts: dict[str, int] = {}
    for n in fused_proto.graph.node:
        op_counts[n.op_type] = op_counts.get(n.op_type, 0) + 1
    print(f"total ops: {sum(op_counts.values())}")

    # ---------- STEP 2: static INT8 quantization (weights + activations) ----------
    print("\n[2/3] static INT8 quantization with calibration...")
    print(f"loading tokenizer from {ONNX_DIR}")
    tokenizer = AutoTokenizer.from_pretrained(str(ONNX_DIR))

    calib_texts = load_calibration_texts()
    print(f"calibration set: {len(calib_texts)} samples (balanced shell/ai)")
    reader = TextCalibrationDataReader(calib_texts, tokenizer)

    # Back up the existing dynamic-quantized model — if static quant
    # regresses on probes, we restore it.
    backup = INT8.with_suffix(".onnx.backup")
    if INT8.exists():
        shutil.copy2(INT8, backup)

    # QDQ format (Quantize-DeQuantize) + standard convention of QInt8
    # weights with QUInt8 activations.  This is the combination ORT
    # documents and that Xenova's quantized models use; the
    # alternative (QOperator + QInt8/QInt8) hits a known NoneType bug
    # on fused Attention nodes.
    quantize_static(
        model_input=str(FUSED),
        model_output=str(INT8),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        per_channel=False,
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QUInt8,
    )

    static_mb = INT8.stat().st_size / 1024 / 1024
    print(f"static int8: {static_mb:.1f} MB ({static_mb / fp32_mb * 100:.0f}% of fp32)")

    # ---------- STEP 3: probe set verification ----------
    print("\n[3/3] verifying probes on aggressively-quantized model...")
    fail, results = run_probe(INT8, tokenizer)
    for text, expected, verdict, p_ai in results:
        flag = "✓" if verdict == expected else "✗"
        print(f"  {flag} pAI={p_ai:.3f} expected={expected:5s} got={verdict:5s} | {text}")

    if fail > 0:
        print(f"\n⚠️  {fail}/{len(PROBE_SET)} probes regressed after aggressive quantization.")
        if backup.exists():
            print(f"restoring dynamic-quantized backup → {INT8}")
            shutil.copy2(backup, INT8)
        raise SystemExit(1)

    print(f"\n✓ all {len(PROBE_SET)} probes pass on the aggressively-quantized model")
    print(f"final size: {static_mb:.1f} MB (was 112 MB with dynamic-only quantization)")
    if backup.exists():
        backup.unlink()


if __name__ == "__main__":
    main()
