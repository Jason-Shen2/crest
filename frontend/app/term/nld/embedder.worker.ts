/// <reference lib="webworker" />
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// NLD Classifier Worker — runs the fine-tuned shell-vs-NL binary
// classifier in a dedicated worker so per-keystroke inference doesn't
// block the renderer's main thread.
//
// Architecture (post-warp-port): the model is the END-TO-END fine-tuned
// `paraphrase-multilingual-MiniLM-L12-v2 + sequence-classification head`
// produced by `training/finetune_classifier.py`.  No external linear
// head, no prototype matching — just `softmax(model(tokenize(text)))`.
// Same shape as warp's `bert_tiny.onnx` pipeline, only multilingual and
// run from the browser.
//
// Protocol:
//   main → worker  { id, type: "init" }
//   worker → main  { id, type: "ready" }      (or "error")
//   main → worker  { id, type: "classify", text }
//   worker → main  { id, type: "verdict", pShell, pAI }  (or "error")

import {
    EdgeFlowTensor,
    Tokenizer,
    configureOnnxAssets,
    loadModel,
    runInferenceNamed,
    type LoadedModel,
} from "edgeflowjs";
import { env as ortEnv } from "onnxruntime-web/wasm";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

// Hand the WASM URLs to ORT.  See docs/INTEGRATION_LOG.md entries for
// the trail of bugs that made this necessary.
configureOnnxAssets({ wasm: ortWasm, mjs: ortMjs });

// Model + tokenizer URLs.  Both live under crest's `public/nld-model/`
// (gitignored — the 130 MB tarball is built artifact, not source).
const MODEL_URL = "/nld-model/model_quantized.onnx";
const TOKENIZER_URL = "/nld-model/tokenizer.json";

// Must match `MAX_LENGTH` in training/finetune_classifier.py so
// inference token positions are distributed the same way the model
// learned them.  64 was chosen because all probe inputs are short
// commands or short questions.
const MAX_LENGTH = 64;

type WorkerInbound =
    | { id: number; type: "init" }
    | { id: number; type: "classify"; text: string };

type WorkerOutbound =
    | { id: number; type: "ready" }
    | { id: number; type: "verdict"; pShell: number; pAI: number }
    | { id: number; type: "error"; message: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let tokenizer: Tokenizer | null = null;
let model: LoadedModel | null = null;
let modelInputNames: Set<string> = new Set();
let initPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
    if (tokenizer && model) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        tokenizer = await Tokenizer.fromUrl(TOKENIZER_URL);
        const m = await loadModel(MODEL_URL, { cache: true });
        model = m;
        modelInputNames = new Set(m.metadata.inputs.map((i) => i.name));
    })();
    return initPromise;
}

function softmax2(z0: number, z1: number): { p0: number; p1: number } {
    // Two-class numerically stable softmax.  Subtracting the max keeps
    // exp() in a sane range even for very confident logits.
    const m = Math.max(z0, z1);
    const e0 = Math.exp(z0 - m);
    const e1 = Math.exp(z1 - m);
    const sum = e0 + e1;
    return { p0: e0 / sum, p1: e1 / sum };
}

async function classify(text: string): Promise<{ pShell: number; pAI: number }> {
    if (!tokenizer || !model) throw new Error("classifier not initialized");

    const encoded = tokenizer.encode(text, {
        maxLength: MAX_LENGTH,
        padding: "max_length",
        truncation: true,
    });

    const inputIds = new EdgeFlowTensor(
        BigInt64Array.from(encoded.inputIds.map((n) => BigInt(n))),
        [1, encoded.inputIds.length],
        "int64"
    );
    const attentionMask = new EdgeFlowTensor(
        BigInt64Array.from(encoded.attentionMask.map((n) => BigInt(n))),
        [1, encoded.attentionMask.length],
        "int64"
    );

    const named = new Map<string, EdgeFlowTensor>();
    named.set("input_ids", inputIds);
    named.set("attention_mask", attentionMask);
    // XLM-R / multilingual MiniLM doesn't take token_type_ids, but be
    // defensive — the model.metadata tells us what its inputs are.
    if (modelInputNames.has("token_type_ids")) {
        const tokenTypeIds = new EdgeFlowTensor(
            BigInt64Array.from(encoded.inputIds.map(() => BigInt(0))),
            [1, encoded.inputIds.length],
            "int64"
        );
        named.set("token_type_ids", tokenTypeIds);
    }

    const outputs = await runInferenceNamed(model, named);
    // Output is logits of shape [batch=1, num_labels=2].  Label order
    // matches training/finetune_classifier.py LABEL_NAMES: [shell, ai].
    const logits = (outputs[0] as EdgeFlowTensor).toFloat32Array();
    const { p0, p1 } = softmax2(logits[0], logits[1]);
    return { pShell: p0, pAI: p1 };
}

function post(msg: WorkerOutbound): void {
    ctx.postMessage(msg);
}

ctx.addEventListener("message", async (event: MessageEvent<WorkerInbound>) => {
    const msg = event.data;
    try {
        if (msg.type === "init") {
            await ensureLoaded();
            post({ id: msg.id, type: "ready" });
            return;
        }
        if (msg.type === "classify") {
            await ensureLoaded();
            const { pShell, pAI } = await classify(msg.text);
            post({ id: msg.id, type: "verdict", pShell, pAI });
            return;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ id: msg.id, type: "error", message });
    }
});
