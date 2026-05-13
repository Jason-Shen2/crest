#!/usr/bin/env python3
"""End-to-end fine-tune of paraphrase-multilingual-MiniLM-L12-v2 for
shell-vs-NL binary classification.

Architecturally this is the crest equivalent of warp's bert_tiny.onnx:
a transformer with a classification head fused on top, trained
end-to-end with cross-entropy.  Replaces the previous
"frozen-MiniLM + external linear head" pipeline.

The previous frozen approach had an unfixable lexical-bias ceiling
because the embedder produced sentence vectors that were dominated by
shell-token semantics no matter how the head was tuned.  Fine-tuning
all 12 transformer layers + the head lets the classifier reshape its
internal feature space for the actual shell-vs-NL task.

Output: training/onnx_model/ — a directory containing the exported
ONNX model + tokenizer that crest's worker can load via edgeFlow.js's
text-classification pipeline.
"""

import json
import shutil
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
)

ROOT = Path(__file__).parent
DATA = ROOT / "data.jsonl"
CORRECTIONS = ROOT / "corrections.jsonl"
OUTPUT_DIR = ROOT / "finetuned_model"        # pytorch checkpoint
ONNX_OUTPUT_DIR = ROOT / "onnx_model"         # ONNX export crest consumes
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

LABEL_NAMES = ["shell", "ai"]
LABEL_TO_ID = {name: i for i, name in enumerate(LABEL_NAMES)}

# Hyperparameters — kept conservative because we're fine-tuning 118M
# params on only ~5K samples.  Higher LR or more epochs would overfit
# fast.
EPOCHS = 3
BATCH_SIZE = 16
LR = 2e-5
WEIGHT_DECAY = 0.01
WARMUP_RATIO = 0.1
MAX_LENGTH = 64  # most inputs are very short

PROBE_SET = [
    ("ls -la", "shell"),
    ("git status", "shell"),
    ("rm -rf /tmp/foo", "shell"),
    ("npm install", "shell"),
    ("docker compose up -d", "shell"),
    ("kubectl get pods -n prod", "shell"),
    ("what does ls -la do", "ai"),
    ("how do I list files", "ai"),
    ("hello", "ai"),
    ("thanks", "ai"),
    ("ls -la 是什么意思", "ai"),
    ("git status 怎么用", "ai"),
    ("怎么列出当前目录下的文件", "ai"),
    ("帮我看看这条命令", "ai"),
    ("ls -la means what?", "ai"),
    ("ls -la means what", "ai"),
    ("what means ls -la", "ai"),
    ("ls means", "ai"),
    ("git rebase 是干嘛的", "ai"),
    ("docker compose up 这条命令的作用", "ai"),
    ("can you explain rm -rf for me", "ai"),
    ("the npm install command does what", "ai"),
]


def load_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


class TextClassificationDataset(Dataset):
    def __init__(self, texts, labels, tokenizer, max_length=MAX_LENGTH):
        self.texts = texts
        self.labels = labels
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
        enc = self.tokenizer(
            self.texts[idx],
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
            return_tensors="pt",
        )
        return {
            "input_ids": enc["input_ids"].squeeze(0),
            "attention_mask": enc["attention_mask"].squeeze(0),
            "labels": torch.tensor(self.labels[idx], dtype=torch.long),
        }


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    preds = np.argmax(logits, axis=-1)
    acc = (preds == labels).mean()
    return {"accuracy": float(acc)}


def main():
    # Detect best available accelerator (MPS on Apple Silicon, else CPU).
    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    print(f"device: {device}")

    data = load_jsonl(DATA)
    if CORRECTIONS.exists():
        corrections = load_jsonl(CORRECTIONS)
        print(f"merging {len(corrections)} user corrections")
        data.extend(corrections)

    texts = [d["text"] for d in data]
    labels = np.array([LABEL_TO_ID[d["label"]] for d in data])
    print(f"loaded {len(texts)} examples — {int((labels == 1).sum())} ai, {int((labels == 0).sum())} shell")

    # 90/10 stratified split (manual — sklearn felt overkill here).
    rng = np.random.RandomState(42)
    idx_shell = np.where(labels == 0)[0]
    idx_ai = np.where(labels == 1)[0]
    rng.shuffle(idx_shell)
    rng.shuffle(idx_ai)
    cut_shell = int(0.9 * len(idx_shell))
    cut_ai = int(0.9 * len(idx_ai))
    train_idx = np.concatenate([idx_shell[:cut_shell], idx_ai[:cut_ai]])
    eval_idx = np.concatenate([idx_shell[cut_shell:], idx_ai[cut_ai:]])
    rng.shuffle(train_idx)

    train_texts = [texts[i] for i in train_idx]
    train_labels = labels[train_idx].tolist()
    eval_texts = [texts[i] for i in eval_idx]
    eval_labels = labels[eval_idx].tolist()

    print(f"split: train={len(train_texts)}, eval={len(eval_texts)}")

    print(f"loading {MODEL_NAME} ...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        num_labels=len(LABEL_NAMES),
        id2label={i: name for i, name in enumerate(LABEL_NAMES)},
        label2id=LABEL_TO_ID,
    )
    # Sanity — the saved model.config will carry these to ONNX.
    print(f"labels: {model.config.id2label}")

    train_dataset = TextClassificationDataset(train_texts, train_labels, tokenizer)
    eval_dataset = TextClassificationDataset(eval_texts, eval_labels, tokenizer)

    args = TrainingArguments(
        output_dir=str(OUTPUT_DIR),
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=BATCH_SIZE,
        per_device_eval_batch_size=BATCH_SIZE,
        learning_rate=LR,
        weight_decay=WEIGHT_DECAY,
        warmup_ratio=WARMUP_RATIO,
        logging_steps=50,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="accuracy",
        greater_is_better=True,
        save_total_limit=1,
        report_to="none",
        use_mps_device=(device == "mps"),
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        tokenizer=tokenizer,
        compute_metrics=compute_metrics,
    )

    trainer.train()
    final_metrics = trainer.evaluate()
    print(f"\nFinal eval metrics: {final_metrics}")

    # Save the best model checkpoint (pytorch state).
    trainer.save_model(str(OUTPUT_DIR))
    tokenizer.save_pretrained(str(OUTPUT_DIR))

    # Probe set — qualitative check.
    print("\nprobe set:")
    model.eval()
    model.to("cpu")  # ONNX export and quick probe run on CPU
    with torch.no_grad():
        for text, expected in PROBE_SET:
            enc = tokenizer(
                text,
                truncation=True,
                padding="max_length",
                max_length=MAX_LENGTH,
                return_tensors="pt",
            )
            logits = model(**enc).logits
            probs = torch.softmax(logits, dim=-1)[0]
            p_ai = float(probs[1])
            verdict = "ai" if p_ai > 0.5 else "shell"
            flag = "✓" if verdict == expected else "✗"
            print(f"  {flag} pAI={p_ai:.3f} expected={expected:5s} got={verdict:5s} | {text}")

    # ONNX export — uses optimum-onnx's CLI-equivalent main_export.
    print(f"\nexporting ONNX to {ONNX_OUTPUT_DIR}")
    if ONNX_OUTPUT_DIR.exists():
        shutil.rmtree(ONNX_OUTPUT_DIR)
    from optimum.exporters.onnx import main_export
    main_export(
        model_name_or_path=str(OUTPUT_DIR),
        output=str(ONNX_OUTPUT_DIR),
        task="text-classification",
        opset=14,
    )
    print(f"ONNX export complete: {ONNX_OUTPUT_DIR}")
    print("Files:")
    for p in sorted(ONNX_OUTPUT_DIR.iterdir()):
        size = p.stat().st_size
        print(f"  {p.name:35s} {size/1024:>8.1f} KB")


if __name__ == "__main__":
    main()
