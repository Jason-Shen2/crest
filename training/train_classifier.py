#!/usr/bin/env python3
"""Train the NLD tier-2 linear head.

Pipeline:
  1.  Load data.jsonl (+ optional corrections.jsonl for online updates).
  2.  Embed every text through the SAME MiniLM the renderer uses.
  3.  Fit a logistic regression on the resulting 384-dim features.
  4.  Report train / held-out accuracy + a small qualitative probe set.
  5.  Export weights as JSON for crest to bundle.

Output: ../frontend/app/term/nld/classifier-weights.json
"""

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).parent
DATA = ROOT / "data.jsonl"
CORRECTIONS = ROOT / "corrections.jsonl"  # optional, written by crest at runtime
OUT = ROOT.parent / "frontend" / "app" / "term" / "nld" / "classifier-weights.json"

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

# Probes — short list of inputs we want manually verified after every
# training run.  Picked to surface the lexical-bias failure mode that
# motivated this whole rewrite.
PROBE_SET = [
    # Pure shell — must stay shell.
    ("ls -la", "shell"),
    ("git status", "shell"),
    ("rm -rf /tmp/foo", "shell"),
    ("npm install", "shell"),
    ("docker compose up -d", "shell"),
    ("kubectl get pods -n prod", "shell"),
    # Standard wh-prefix questions — must be NL.
    ("what does ls -la do", "ai"),
    ("how do I list files", "ai"),
    ("hello", "ai"),
    ("thanks", "ai"),
    # CJK questions — must be NL.
    ("ls -la 是什么意思", "ai"),
    ("git status 怎么用", "ai"),
    ("怎么列出当前目录下的文件", "ai"),
    ("帮我看看这条命令", "ai"),
    # Hard cases that exposed the lexical-bias problem:
    ("ls -la means what?", "ai"),         # reverse word-order EN
    ("ls -la means what", "ai"),          # same, no punctuation
    ("what means ls -la", "ai"),          # head-final EN
    ("ls means", "ai"),                   # truncated question
    ("git rebase 是干嘛的", "ai"),         # CJK alt phrasing
    ("docker compose up 这条命令的作用", "ai"),  # command embedded mid-sentence ZH
    ("can you explain rm -rf for me", "ai"),    # command mid-sentence EN
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


def main():
    data = load_jsonl(DATA)
    corrections = load_jsonl(CORRECTIONS)
    if corrections:
        print(f"merging {len(corrections)} user corrections")
        data.extend(corrections)

    texts = [d["text"] for d in data]
    labels = np.array([1 if d["label"] == "ai" else 0 for d in data])
    print(f"loaded {len(texts)} examples — {(labels == 1).sum()} ai, {(labels == 0).sum()} shell")

    print(f"loading {MODEL_NAME} ...")
    model = SentenceTransformer(MODEL_NAME)

    print("embedding (one-shot, batched) ...")
    X = model.encode(
        texts,
        batch_size=64,
        show_progress_bar=True,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    print(f"embedded → shape {X.shape}")

    # Hold out 10% for honest accuracy.  Stratified so both classes are
    # represented in the eval split.
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, labels, test_size=0.1, stratify=labels, random_state=42
    )

    # Class weights — compute by hand to target *mild* NL bias, ~1.5:1
    # effective gradient mass in favor of NL.  Raw sample counts are
    # ~4146 NL vs ~534 shell, so:
    #
    #     w_nl  / w_shell  =  desired_effective_ratio × n_shell / n_nl
    #                      ≈  1.5 × 534 / 4146
    #                      ≈  0.193
    #
    # i.e. shell samples get ~5x the per-sample weight of NL.
    #
    # Default 'balanced' would give shell 7.8x — too far the other way,
    # producing a head that misclassifies "ls -la means what?" because
    # the embedder's lexical bias plus the trained shell-bias compound.
    # Uniform weights (no class_weight) would give shell 1x — produces
    # the failure we just saw, where every command-shaped input flipped
    # to NL.  The 5:1 below is the middle ground that matches the
    # product framing in nld-model.ts: tier-2 should lean NL when in
    # doubt, but still classify obvious commands correctly.
    n_shell = int((labels == 0).sum())
    n_ai = int((labels == 1).sum())
    target_nl_advantage = 1.5  # effective gradient ratio nl : shell
    w_nl = 1.0
    w_shell = target_nl_advantage * n_ai / n_shell
    clf = LogisticRegression(
        max_iter=2000,
        C=1.0,
        class_weight={0: w_shell, 1: w_nl},
        solver="lbfgs",
    )
    print(f"class weights: shell={w_shell:.3f} nl={w_nl:.3f}")
    clf.fit(X_tr, y_tr)
    train_acc = clf.score(X_tr, y_tr)
    test_acc = clf.score(X_te, y_te)
    print(f"train acc: {train_acc:.4f}")
    print(f"held-out:  {test_acc:.4f}")

    # Probe results — the qualitative check that matters more than the
    # aggregate accuracy.  Single misclassification on a probe is louder
    # than 1% loss on the held-out split.
    print()
    print("probe set:")
    probe_texts = [t for t, _ in PROBE_SET]
    probe_X = model.encode(probe_texts, normalize_embeddings=True, convert_to_numpy=True)
    probe_logits = probe_X @ clf.coef_[0] + clf.intercept_[0]
    probe_pAI = 1.0 / (1.0 + np.exp(-probe_logits))
    for (text, expected), p in zip(PROBE_SET, probe_pAI):
        verdict = "ai" if p > 0.5 else "shell"
        flag = "✓" if verdict == expected else "✗"
        print(f"  {flag} pAI={p:.3f} expected={expected:5s} got={verdict:5s} | {text}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "model": MODEL_NAME,
                "dim": int(X.shape[1]),
                "weights": clf.coef_[0].tolist(),  # 384 floats
                "bias": float(clf.intercept_[0]),
                "train_samples": int(len(X_tr)),
                "train_accuracy": float(train_acc),
                "eval_accuracy": float(test_acc),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
