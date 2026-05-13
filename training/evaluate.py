#!/usr/bin/env python3
"""Progressive-typing evaluator for the NLD classifier.

Ports warp's `crates/input_classifier/src/bin/evaluate.rs` concept to
Python.  For each input in the eval corpus we generate every prefix
(1 char, 2 chars, …, full string), run the classifier on each, and
surface three things the offline probe set can't:

  1.  **Flicker**: does the verdict change across prefixes?  A good
      classifier converges and stays — flipping shell↔ai mid-typing is
      worse UX than a slightly-late commit.
  2.  **Convergence point**: at what prefix length does the verdict
      stabilize to its final answer?  Shorter is better for snappy UX.
  3.  **Stability of confidence**: even when the label stays correct,
      a wildly oscillating pAI means the model is genuinely uncertain.

Output is colored terminal + a JSON dump for tracking across runs.

This script tests the ONNX classifier directly (the tier-2 model).
Tier-1 short-circuits aren't evaluated here — they're deterministic
and unit-tested in TypeScript.  The interesting question is whether
the fine-tuned BERT-classifier behaves stably while the user types.
"""

import json
import sys
from pathlib import Path

import numpy as np
from onnxruntime import InferenceSession
from transformers import AutoTokenizer

ROOT = Path(__file__).parent
ONNX_DIR = ROOT / "onnx_model"
MODEL = ONNX_DIR / "model_quantized.onnx"
MAX_LENGTH = 64

# Inputs to evaluate.  Mix of shell / NL, English / CJK, easy / borderline.
# `min_useful_len` is the prefix length below which we don't expect a
# correct verdict (typing the first char of "git status" can't be
# reasonably classified as shell yet).
CORPUS = [
    # (text, expected_label, min_useful_prefix_len)
    # Pure shell — should converge fast
    ("ls -la", "shell", 2),
    ("git status", "shell", 4),
    ("rm -rf /tmp/foo", "shell", 4),
    ("npm install react", "shell", 5),
    ("docker compose up -d", "shell", 7),
    ("kubectl get pods -n prod", "shell", 9),
    ("cat /etc/hosts | grep localhost", "shell", 5),
    ("find . -name '*.ts' -not -path '*/node_modules/*'", "shell", 6),
    ("export PATH=$PATH:/usr/local/bin", "shell", 7),
    # English NL questions
    ("what does ls -la do", "ai", 4),
    ("how do I list all files", "ai", 4),
    ("explain the rm -rf command", "ai", 4),
    ("why is my docker container failing", "ai", 4),
    ("ls -la means what?", "ai", 8),  # tricky — looks shell early
    ("can you help me write a python script", "ai", 4),
    # English short
    ("hello", "ai", 3),
    ("thanks for the help", "ai", 4),
    # CJK questions
    ("ls -la 是什么意思", "ai", 8),
    ("git status 怎么用", "ai", 8),
    ("怎么列出当前目录下的文件", "ai", 2),
    ("帮我看看这条命令", "ai", 2),
    ("docker compose up 这条命令的作用", "ai", 12),
    # Mixed
    ("explain git rebase to me", "ai", 4),
    ("是什么意思 ls -la", "ai", 1),  # NL-first
    # Borderline — flickers are likely
    ("clean up the build artifacts", "ai", 5),  # no command at front
    ("run all tests", "ai", 4),
]


def color_for(correct: bool, p_ai: float) -> str:
    """Green for correct, red for wrong; dim if low confidence (<70%)."""
    confident = abs(p_ai - 0.5) > 0.2
    if correct:
        return "\x1b[32m" if confident else "\x1b[32m\x1b[2m"
    else:
        return "\x1b[31m" if confident else "\x1b[31m\x1b[2m"


RESET = "\x1b[0m"
GRAY = "\x1b[90m"


def classify(sess, tokenizer, input_names, text: str) -> float:
    """Run the ONNX classifier on `text`, return pAI."""
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
            enc["token_type_ids"].astype(np.int64)
            if "token_type_ids" in enc
            else np.zeros_like(enc["input_ids"]).astype(np.int64)
        )
    logits = sess.run(None, feed)[0][0]
    m = logits.max()
    e = np.exp(logits - m)
    probs = e / e.sum()
    return float(probs[1])


def evaluate_prefixes(sess, tokenizer, input_names, text: str, expected: str, min_useful_len: int):
    """Run the classifier on every prefix; return per-prefix records + stats."""
    prefixes = [text[: i + 1] for i in range(len(text))]
    records = []
    last_verdict = None
    flicker_count = 0
    converge_idx = None

    for i, prefix in enumerate(prefixes, start=1):
        p_ai = classify(sess, tokenizer, input_names, prefix)
        verdict = "ai" if p_ai > 0.5 else "shell"
        correct = verdict == expected
        # Flicker = verdict changed from the previous prefix.  Skip the
        # first transition (every input starts somewhere) and only count
        # changes that happen AFTER the "min useful length" — flickers
        # at 1-2 chars don't reflect real classifier instability.
        is_flicker = (
            last_verdict is not None
            and verdict != last_verdict
            and i > min_useful_len
        )
        if is_flicker:
            flicker_count += 1
        last_verdict = verdict
        records.append(
            {
                "prefix": prefix,
                "len": i,
                "p_ai": p_ai,
                "verdict": verdict,
                "correct": correct,
                "flicker": is_flicker,
            }
        )

    # Convergence: walk backwards, find longest suffix where verdict is
    # stable AND correct.  Convergence point is the first index where
    # the verdict matched the final stable answer and never flipped
    # afterwards.
    final_verdict = records[-1]["verdict"]
    converge_idx = len(records)  # default: never converges
    for i in range(len(records) - 1, -1, -1):
        if records[i]["verdict"] != final_verdict:
            converge_idx = i + 1
            break
        if i == 0:
            converge_idx = 0

    return records, flicker_count, converge_idx, final_verdict


def render(text: str, expected: str, records: list, flicker_count: int, converge_idx: int):
    print(f"\n{GRAY}Input:{RESET} {text!r}  {GRAY}expected:{RESET} {expected}")
    # One line per prefix.  Show truncated prefix + verdict color + pAI.
    for r in records:
        c = color_for(r["correct"], r["p_ai"])
        flicker_mark = "⚡" if r["flicker"] else " "
        prefix_disp = r["prefix"].replace("\n", "↵")
        print(
            f"  {flicker_mark} {c}{r['verdict']:5s}{RESET}"
            f" pAI={r['p_ai']:.3f}"
            f" {GRAY}[{r['len']:>2}]{RESET}"
            f" {prefix_disp!r}"
        )
    final = records[-1]
    final_ok = "✓" if final["correct"] else "✗"
    print(
        f"  {GRAY}→{RESET} final: {final_ok} {final['verdict']} pAI={final['p_ai']:.3f}"
        f"  flickers={flicker_count}  converges@{converge_idx}/{len(records)}"
    )


def main():
    if not MODEL.exists():
        sys.exit(f"missing {MODEL} — run finetune_classifier.py first")

    sess = InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    input_names = {i.name for i in sess.get_inputs()}
    tokenizer = AutoTokenizer.from_pretrained(ONNX_DIR)

    summary = {"correct_final": 0, "total": 0, "total_flickers": 0, "total_converge": 0}
    detailed = []

    for text, expected, min_useful in CORPUS:
        records, flicker_count, converge_idx, final_verdict = evaluate_prefixes(
            sess, tokenizer, input_names, text, expected, min_useful
        )
        render(text, expected, records, flicker_count, converge_idx)

        summary["total"] += 1
        if final_verdict == expected:
            summary["correct_final"] += 1
        summary["total_flickers"] += flicker_count
        summary["total_converge"] += converge_idx
        detailed.append(
            {
                "text": text,
                "expected": expected,
                "final_verdict": final_verdict,
                "final_p_ai": records[-1]["p_ai"],
                "flickers": flicker_count,
                "converge_at": converge_idx,
                "length": len(text),
            }
        )

    # Aggregate report.
    n = summary["total"]
    print(f"\n{GRAY}═══ AGGREGATE ═══{RESET}")
    print(f"final-accuracy:  {summary['correct_final']}/{n} = {summary['correct_final'] / n:.0%}")
    print(f"flickers/input:  {summary['total_flickers'] / n:.2f} (avg)")
    print(f"converge@avg:    {summary['total_converge'] / n:.1f} chars")

    # Persist for tracking across runs.
    out = ROOT / "eval_results.json"
    out.write_text(json.dumps({"summary": summary, "inputs": detailed}, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
