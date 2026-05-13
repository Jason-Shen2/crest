#!/usr/bin/env python3
"""Aggressive ONNX quantization via HuggingFace optimum.

Replaces quantize_aggressive.py.  optimum-onnx's `ORTQuantizer` +
`AutoQuantizationConfig` knows the BERT family well enough to apply
transformer-specific fusions AND quantize the fused ops cleanly —
which is exactly the combination that produced the ~30 MB
`model_quantized.onnx` files Xenova ships.  Vanilla
`onnxruntime.quantization.quantize_static` lands at ~110 MB because
without the BERT-aware shape inference it can't quantize fused
Attention / SkipLayerNorm nodes.
"""

import json
import random
import shutil
from pathlib import Path

import numpy as np
from optimum.onnxruntime import AutoQuantizationConfig, ORTQuantizer
from transformers import AutoTokenizer

random.seed(42)

ROOT = Path(__file__).parent
ONNX_DIR = ROOT / "onnx_model"
SOURCE_MODEL = ONNX_DIR / "model.onnx"        # fp32 from finetune
QUANT_OUTPUT = ONNX_DIR / "model_quantized.onnx"  # what crest loads
DATA = ROOT / "data.jsonl"

MAX_LENGTH = 64
CALIBRATION_SIZE = 500

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


def sample_balanced(n: int) -> list[str]:
    rows = [json.loads(line) for line in DATA.open() if line.strip()]
    shell = [r["text"] for r in rows if r["label"] == "shell"]
    nl = [r["text"] for r in rows if r["label"] == "ai"]
    random.shuffle(shell)
    random.shuffle(nl)
    half = n // 2
    return shell[:half] + nl[:half]


def run_probe(model_path: Path, tokenizer) -> tuple[int, list]:
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
        if "token_type_ids" in input_names:
            feed["token_type_ids"] = (
                enc["token_type_ids"].astype(np.int64) if "token_type_ids" in enc
                else np.zeros_like(enc["input_ids"]).astype(np.int64)
            )
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
    if not SOURCE_MODEL.exists():
        raise SystemExit(f"fp32 source missing: {SOURCE_MODEL}")
    fp32_mb = SOURCE_MODEL.stat().st_size / 1024 / 1024
    print(f"source fp32: {fp32_mb:.1f} MB")

    # Backup current quantized model so we can fall back if probes regress.
    backup = QUANT_OUTPUT.with_suffix(".onnx.backup")
    if QUANT_OUTPUT.exists():
        shutil.copy2(QUANT_OUTPUT, backup)
        print(f"backed up current quantized model → {backup.name}")

    # `ORTQuantizer` reads the source ONNX directory; the model file
    # in that directory MUST be named `model.onnx` for from_pretrained
    # to find it.  Our finetune script already saves it that way.
    print("\nbuilding ORTQuantizer ...")
    quantizer = ORTQuantizer.from_pretrained(ONNX_DIR, file_name="model.onnx")

    # avx512_vnni or arm64 — both are CPU INT8 instruction sets.  We
    # pick avx512_vnni for the calibration config (it's the most common
    # on x86 servers); the resulting model also runs on arm64 / WASM
    # since the int8 ops have generic implementations.  `per_channel`
    # quantization gives a non-trivial accuracy boost on transformer
    # weights with negligible size cost.
    quant_config = AutoQuantizationConfig.avx512_vnni(
        is_static=True,
        per_channel=True,
        use_symmetric_activations=False,
        use_symmetric_weights=True,
    )

    print("loading tokenizer + sampling calibration set ...")
    tokenizer = AutoTokenizer.from_pretrained(ONNX_DIR)
    calib_texts = sample_balanced(CALIBRATION_SIZE)
    print(f"calibration: {len(calib_texts)} samples")

    # optimum needs a HuggingFace Dataset for calibration.
    from datasets import Dataset
    calib_dataset = Dataset.from_dict({"text": calib_texts})

    def preprocess(examples):
        return tokenizer(
            examples["text"],
            truncation=True,
            padding="max_length",
            max_length=MAX_LENGTH,
        )

    calib_dataset = calib_dataset.map(preprocess, batched=True, remove_columns=["text"])

    print("\n[1/2] calibrating (collecting activation ranges) ...")
    from optimum.onnxruntime.configuration import AutoCalibrationConfig
    calibration_config = AutoCalibrationConfig.minmax(calib_dataset)
    ranges = quantizer.fit(
        dataset=calib_dataset,
        calibration_config=calibration_config,
        operators_to_quantize=quant_config.operators_to_quantize,
    )

    print("\n[2/2] applying static int8 quantization + transformer fusion ...")
    tmp_out = ONNX_DIR.parent / "optimum_tmp"
    if tmp_out.exists():
        shutil.rmtree(tmp_out)
    tmp_out.mkdir()

    quantizer.quantize(
        save_dir=tmp_out,
        quantization_config=quant_config,
        calibration_tensors_range=ranges,
    )

    produced = list(tmp_out.glob("model_quantized*.onnx"))
    if not produced:
        produced = list(tmp_out.glob("*.onnx"))
    if not produced:
        raise SystemExit(f"optimum didn't produce an ONNX file in {tmp_out}")
    shutil.move(produced[0], QUANT_OUTPUT)
    shutil.rmtree(tmp_out)

    out_mb = QUANT_OUTPUT.stat().st_size / 1024 / 1024
    print(f"\nquantized model: {out_mb:.1f} MB ({out_mb / fp32_mb * 100:.0f}% of fp32)")

    # Probe verification — fall back if regression.
    fail, results = run_probe(QUANT_OUTPUT, tokenizer)
    for text, expected, verdict, p_ai in results:
        flag = "✓" if verdict == expected else "✗"
        print(f"  {flag} pAI={p_ai:.3f} expected={expected:5s} got={verdict:5s} | {text}")

    if fail > 0:
        print(f"\n⚠️  {fail}/{len(PROBE_SET)} probes regressed — restoring backup")
        if backup.exists():
            shutil.copy2(backup, QUANT_OUTPUT)
        raise SystemExit(1)

    if backup.exists():
        backup.unlink()
    print(f"\n✓ all {len(PROBE_SET)} probes pass on the optimum-quantized model")


if __name__ == "__main__":
    main()
