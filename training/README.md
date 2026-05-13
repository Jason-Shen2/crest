# NLD Classifier Training

Trains the tier-2 linear classification head on top of frozen
`paraphrase-multilingual-MiniLM-L12-v2` embeddings.  Output is a tiny
JSON of 384 weights + 1 bias that ships inside crest's renderer bundle.

## One-time setup

```bash
cd training
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

First `pip install` downloads ~500 MB (PyTorch + transformers cache).

## Generate the dataset

`data.jsonl` is produced from templates + curated lists in
`generate_v0.py`.  Re-run any time the source seeds change:

```bash
python generate_v0.py
```

Outputs `training/data.jsonl` with one `{text, label}` per line.

## Train

```bash
python train_classifier.py
```

- Loads `data.jsonl`
- Embeds every entry through MiniLM (one-shot, ~1 min cold, < 10 s warm)
- Fits a logistic regression head
- Reports train / validation accuracy
- Writes `../frontend/app/term/nld/classifier-weights.json`

After this, crest's tier-2 picks up the new weights on next reload.

## Online corrections

(future) `corrections.jsonl` collects samples the user manually corrected
in-app.  When present, `train_classifier.py` appends it to `data.jsonl`
during training so future versions benefit from real misclassifications.

## License notes

- `data.jsonl` may include lines derived from public datasets — keep
  attribution in `generate_v0.py` if you import third-party data.
- `classifier-weights.json` is produced from those inputs and ships
  under crest's Apache-2.0 license.  Do not import AGPL-licensed model
  weights or training data into this pipeline.
